import express from 'express'
import cors from 'cors'
import SSEChannel from 'sse-pubsub'
import fileUpload from 'express-fileupload'
import bearerToken from 'express-bearer-token'
import * as Sentry from '@sentry/node'
import { STATUS_CODES, createServer } from 'http'
import { createServer as createHTTP2Server, ServerOptions } from 'spdy'
import { Runtype, Static } from 'runtypes'
import swaggerUI from 'swagger-ui-express'
import { APIUser } from './Internal/Runtypes'
import { Logger } from 'pino'

/*
    Basically the LIIT implementation in a 200 lines + conforming to REST API standards
*/
const TMP_FILE_PATH = 'tmp/'
const UNAUTHORIZED = 401

export type ClientType = {end: () => void, logger: Logger}

export type AppOptions<T> = {
    port: number 
    makeClient: (teamId: string, remove: () => void, ...args: any[]) => Promise<T>
    secPort?: number
    secOptions?: ServerOptions
    isBehindProxy?: boolean
    maxFileSizeBytes?: number
    logAllErrorsOnSentry?: boolean
    onLiveConnection: (teamId: string) => void
    authenticator: (token: string) => Promise<APIUser>
    ssePath?: string
    openAPIDocs?: any
}
export type RouteMethod = 'get' | 'post' | 'delete' | 'put' | 'patch' | 'head'
export type RouteParameters<T, Client> = {
    path: string
    method: RouteMethod
    type?: Runtype<T>
    middlewares?: ((req, res, next?) => any)[]
    respond: (options: Static<Runtype<T>>, client: Client, user: APIUser) => Promise<any | void>
}
export type Application<Client> = express.Application & {
    close (): Promise<void>
    getClient: (key: string, ...args: any[]) => Promise<Client>
    broadcast (teamId: string, event: string, data: any): void
    routing<T> (params: RouteParameters<T, Client>): Application<Client>
}
export class HTTPError extends Error {
    code: number
    constructor (message: string, code: number) {
        super (message)
        this.code = code
    }
}
export const CacheControl = (maxAge: number = 5*60) => (req, res, next?) => {
    res.setHeader (`Cache-Control`, `max-age=${maxAge}`)
    next ()
}

export function App <Client extends ClientType> (options: AppOptions<Client>) {
    const sseConnections: { [k: string]: SSEChannel } = { }
    const clients: {[k: string]: Promise<Client> } = {}
    const app = express () as any as Application<Client>
    
    app.close = async () => {
        server.setTimeout (10)
        serverSecure?.setTimeout (10)
        server.close ()
        serverSecure?.close ()
        await Promise.all (
            Object.values (clients).map (client => client.then(c => c.end()))
        )
    }
    app.broadcast = (teamId: string, event: string, data: any) => {
        //console.log (`broadcasting to ${teamId}, ${event}, ${data}`)
        const sse = sseConnections[teamId]
        sse && sse.publish (JSON.stringify(data), event)
    }
    app.getClient = async (teamId: string) => {
        if (!clients[teamId]) {
            console.log (`creating client for ${teamId}`)
            const remove = () => delete clients[teamId]
            clients[teamId] = options.makeClient (teamId, remove)
        } 
        const client = await clients[teamId]
        return client
    }
    app.routing = function <T> (params: RouteParameters<T, Client>) {
        const {method, respond, path} = params
        const middlewares = params.middlewares || []
        app[method](path, ...middlewares, async (req, res) => {
            const startDate = new Date()
            const timeTakenS = () => Math.floor( (new Date().getTime() - startDate.getTime())/1000 )
            const mPath = `${req.method} ${req.path}`
            // create a combined body from the request
            let body = req.body || {}
            
            try {
                if (req.files) {
                    Object.values (req.files).forEach (file => {
                        file.url = file.tempFilePath
                        delete file.tempFilePath
                    })
                    body = { ...body, ...req.files } // include files in
                }
                if (req.query) body = { ...body, ...req.query } // include query in
                if (req.params) body = { ...body, ...req.params } // include params in

                // assert & throw bad request if not conforming
                try { params.type?.assert (body) } catch (err) { throw new HTTPError(err.message, 400) }
                
                const response = await respond (body, req.client as Client, req.user)
                if (response?.redirect) res.redirect (response.redirect)
                else res.status (200).send (response)

                req.client.logger.trace({ path: mPath, success: true, ip: req.ip, responseTime: timeTakenS() })
            } catch (error) {
                let code = error.code || error.status || 500
                if (typeof code !== 'number') code = 500
                
                // capture type errors
                if (error instanceof TypeError || options.logAllErrorsOnSentry) {
                    Sentry.captureException (error, { extra: {
                        path: mPath,
                        params: { ...req.body, ...req.query }
                    }})
                }
                res.status (code).send (
                    { code, error: error.message || 'unknown', message: STATUS_CODES[code] }
                )
                const method = code >= 500 ? 'error' : 'trace'
                req.client.logger[method]({ path: mPath, body, error: error.message, trace: error?.stack?.toString(), ip: req.ip, responseTime: timeTakenS() })
            }
        })
        return app
    }

    options.maxFileSizeBytes = options.maxFileSizeBytes || 1024*1024*1024
    options.openAPIDocs && app.use ('/docs', swaggerUI.serve, swaggerUI.setup(options.openAPIDocs))
    options.isBehindProxy && app.enable ('trust proxy')

    app.use(Sentry.Handlers.requestHandler())
    app.use(Sentry.Handlers.tracingHandler())
    app.use(Sentry.Handlers.errorHandler())

    app.use(cors())
    app.use (bearerToken())
    app.use (express.json())
    app.use (express.urlencoded({ extended: true }))
    app.use (
        fileUpload ({ 
            useTempFiles: true,
            tempFileDir: TMP_FILE_PATH, 
            safeFileNames: false, 
            abortOnLimit: true,
            parseNested: true,
            limits: { fileSize: options.maxFileSizeBytes } // 10 MB default max limit
        })
    )
    // Authentication
    app.use ((req, res, next) => {
        const token = req.token
        if (typeof token !== 'string') {
            res.status (UNAUTHORIZED).send ({ code: UNAUTHORIZED, error: STATUS_CODES[401] })
        } else {
            options.authenticator (token)
            .then (user => req.user = user)
            .then (() => delete req.query.access_token)
            .then (() => next())
            .catch (err => {
                res.status (UNAUTHORIZED).send ({ code: UNAUTHORIZED, error: err.message })
                if (err instanceof TypeError) {
                    console.error (err)
                    Sentry.captureException (err)
                }
            })
        }
    })
    if (options.ssePath) {
        // Live events
        app.use ((req, res, next) => {
            if (req.path === options.ssePath) {
                const teamId = req.user.teamId
                if (!sseConnections[teamId]) {
                    sseConnections[teamId] = new SSEChannel ({ rewind: 0, historySize: 200 })
                }
                sseConnections[teamId].subscribe (req, res)
                options.onLiveConnection (teamId)
            } else next ()
        })
        console.log (`enabled SSE on ${options.ssePath}`)
    }
    // Create/get client for request
    app.use ((req, res, next) => {
        const teamId = req.user.teamId
        if (!teamId) {
            res.status (403).send ({ code: 403, error: 'No team ID present in user' })
            return
        }

        app.getClient (teamId)
        .then (client => req.client = client)
        .then (() => next())
        .catch (err => {
            console.log (`unexpected error in creating client for ${teamId}: ${err}`)
            res.status(500).send({ code: 500, error: err.message })
            Sentry.captureException (err)
        })
    })
    
    const server = createServer (app)
    server.listen (options.port, () => console.log ('started HTTP server on ' + options.port))

    const serverSecure = options.secOptions ? createHTTP2Server(options.secOptions, app) : null
    serverSecure?.listen (options.secPort, () => console.log ('started HTTP2 server on ' + options.secPort))

    return app
}
declare global {
    namespace Express {
        export interface Request {
            user: APIUser
            client: ClientType
            files?: any[]
        }
    }
}