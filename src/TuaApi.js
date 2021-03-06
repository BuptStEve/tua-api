import koaCompose from 'koa-compose'

import { version } from '../package.json'
import {
    map,
    pipe,
    isWx,
    logger,
    mergeAll,
    apiConfigToReqFnParams,
} from './utils'
import {
    VALID_REQ_TYPES,
} from './constants'
import {
    getWxPromise,
    getAxiosPromise,
    getFetchJsonpPromise,
} from './adapters/'
import {
    formatResDataMiddleware,
    recordReqTimeMiddleware,
    updateFullUrlMiddleware,
    recordStartTimeMiddleware,
    formatReqParamsMiddleware,
} from './middlewareFns'

logger.log(`Version: ${version}`)
class TuaApi {
    /**
     * @param {Object} options
     * @param {String} options.host 服务器基础地址，例如 https://example.com/
     * @param {String} options.reqType 请求类型
     * @param {Function[]} options.middleware 中间件函数数组
     * @param {Object} options.axiosOptions 透传 axios 配置参数
     * @param {Object} options.jsonpOptions 透传 fetch-jsonp 配置参数
     * @param {Object} options.defaultErrorData 出错时的默认数据
     */
    constructor ({
        host,
        reqType = isWx() ? 'wx' : 'axios',
        middleware = [],
        axiosOptions = {},
        jsonpOptions = {},
        defaultErrorData = { code: 999, msg: '出错啦！' },
    } = {}) {
        this.host = host
        this.reqType = reqType
        this.middleware = middleware
        this.axiosOptions = axiosOptions
        this.jsonpOptions = jsonpOptions
        this.defaultErrorData = defaultErrorData

        this._checkReqType()

        return this
    }

    /* -- 各种对外暴露方法 -- */

    /**
     * 添加一个中间件函数
     * @param {Function} fn
     * @return {Application} self
     */
    use (fn) {
        if (typeof fn !== 'function') {
            throw TypeError('middleware must be a function!')
        }
        this.middleware.push(fn)

        return this
    }

    /**
     * 根据 apiConfig 生成请求函数组成的 map
     * @param {Object} apiConfig
     * @return {Object}
     */
    getApi (apiConfig) {
        return pipe(
            apiConfigToReqFnParams,
            map(this._getOneReqMap.bind(this)),
            mergeAll,
        )(apiConfig)
    }

    /* -- 各种私有方法 -- */

    /**
     * 根据 reqType 和 type 决定调用哪个库
     * @param {Object} options
     * @param {String} options.url 接口地址
     * @param {String} options.type 接口请求类型 get/post...
     * @param {String} options.fullUrl 完整接口地址（）
     * @param {String} options.path 接口路径名称
     * @return {Promise}
     */
    _reqFn ({
        url,
        type,
        fullUrl,
        reqType,
        reqParams: data,
        callbackName,
        jsonpOptions,
        axiosOptions,
        ...rest
    }) {
        if (VALID_REQ_TYPES.indexOf(reqType) === -1) {
            logger.error(`reqType 的有效值为: ${VALID_REQ_TYPES.join(', ')}!`)
            throw Error('invalid reqType')
        }

        const method = type.toUpperCase()

        if (reqType === 'wx') {
            return getWxPromise({ url, fullUrl, data, method, ...rest })
        }

        if (reqType === 'axios') {
            const params = {
                url: method === 'GET' ? fullUrl : url,
                data,
                method,
                ...axiosOptions,
                ...rest,
            }

            return getAxiosPromise(params)
        }

        // 对于 post 请求使用 axios
        return method === 'POST'
            ? getAxiosPromise({ url, data, ...axiosOptions })
            : getFetchJsonpPromise({
                url: fullUrl,
                jsonpOptions: { ...jsonpOptions, callbackName },
            })
    }

    /**
     * 检查 reqType 是否合法
     */
    _checkReqType () {
        if (VALID_REQ_TYPES.indexOf(this.reqType) === -1) {
            logger.error(`invalid reqType: ${this.reqType}, support these reqType: ${VALID_REQ_TYPES}`)
            throw TypeError(`invalid reqType`)
        }
    }

    /**
     * 组合生成中间件函数
     * @param {Function[]} middleware
     * @param {Boolean} useGlobalMiddleware 是否使用全局中间件
     */
    _getMiddlewareFn (middleware, useGlobalMiddleware) {
        const middlewareFns = useGlobalMiddleware
            ? this.middleware.concat(middleware)
            : middleware

        return koaCompose([
            // 记录开始时间
            recordStartTimeMiddleware,
            // 格式化生成请求参数
            formatReqParamsMiddleware,
            // 业务侧中间件函数数组
            ...middlewareFns,
            // 更新请求参数
            updateFullUrlMiddleware,
            // 统一转换响应数据为对象
            formatResDataMiddleware,
            // 记录结束时间
            recordReqTimeMiddleware,
            // 发起请求
            (ctx, next) => next()
                .then(() => this._reqFn(ctx.req.reqFnParams))
                // 暂存出错，保证 afterFn 能执行（finally）
                .catch((error) => ({
                    // 浅拷贝一份默认出错值
                    data: { ...this.defaultErrorData },
                    error,
                }))
                .then((res) => { ctx.res = res }),
        ])
    }

    /**
     * 接受 api 对象，返回待接收参数的单个 api 函数的对象
     * @param {Object} options
     * @param {String} options.type 接口请求类型 get/post...
     * @param {String} options.name 自定义的接口名称
     * @param {String} options.path 接口路径名称
     * @param {String[]} options.params 接口参数数组
     * @param {String} options.prefix 接口前缀
     * @param {Function} options.afterFn 在请求完成后执行的钩子函数（将被废弃）
     * @param {Function} options.beforeFn 在请求发起前执行的钩子函数（将被废弃）
     * @param {Function[]} options.middleware 中间件函数数组
     * @param {Boolean} options.useGlobalMiddleware 是否使用全局中间件
     * @return {Object} 以 apiName 为 key，请求函数为值的对象
     */
    _getOneReqMap ({
        type = 'get',
        name,
        path,
        params = {},
        prefix,
        afterFn = ([x]) => x,
        beforeFn = Promise.resolve.bind(Promise),
        middleware = [],
        useGlobalMiddleware = true,
        ...rest
    }) {
        // 优先使用 name
        const apiName = name || path
        const fullPath = `${prefix}/${path}`

        // 合并全局默认值
        rest.host = rest.host || this.host
        rest.reqType = rest.reqType || this.reqType
        rest.axiosOptions = rest.axiosOptions
            ? { ...this.axiosOptions, ...rest.axiosOptions }
            : this.axiosOptions
        rest.jsonpOptions = rest.jsonpOptions
            ? { ...this.jsonpOptions, ...rest.jsonpOptions }
            : this.jsonpOptions

        /**
         * 被业务侧调用的函数
         * @param {Object} args 接口参数（覆盖默认值）
         * @param {Object} options
         * @param {String} options.callbackName 自定义回调函数名称（用于 jsonp）
         * @return {Promise}
         */
        const apiFn = (
            args = {},
            { callbackName = `${path}Callback` } = {}
        ) => {
            // args 可能为 null
            args = args === null ? {} : args

            // 请求的上下文信息
            const ctx = {
                req: { args, type, path, params, prefix, apiName, fullPath, callbackName, reqFnParams: {}, ...rest },
            }

            // 中间件函数
            const middlewareFn = this._getMiddlewareFn(middleware, useGlobalMiddleware)

            // 执行完 beforeFn 后执行的函数
            const beforeFnCallback = (rArgs = {}) => {
                // 兼容小程序传递请求头（建议还是放在中间件中）
                if (rArgs.header) {
                    ctx.req.reqFnParams.header = rArgs.header
                }

                if (!rArgs.params) return

                // 合并 beforeFn 中传入的 params
                ctx.req.params = Array.isArray(params)
                    ? rArgs.params
                    : {
                        ...params,
                        // 可以通过给 beforeFn
                        // 添加 params 返回值添加通用参数
                        ...rArgs.params,
                    }
            }

            return beforeFn()
                .then(beforeFnCallback)
                // 执行请求中间件函数
                .then(() => middlewareFn(ctx))
                // 请求执行完成后的钩子
                .then(() => afterFn([ctx.res.data, ctx]))
                // 抛出错误或响应数据
                .then(() => ctx.res.error
                    ? Promise.reject(ctx.res.error)
                    : ctx.res.data
                )
        }

        // 将请求的 key 和 params 挂上去，以便在 ssr 时预取数据
        apiFn.key = fullPath
        apiFn.params = params

        return { [apiName]: apiFn }
    }
}

export default TuaApi
export * from './exportUtils'
