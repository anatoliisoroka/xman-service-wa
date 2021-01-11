import got from 'got'
import JWT from 'jsonwebtoken'
import { APIUser } from './Runtypes'
import NodeCache from 'node-cache'
import { Cache } from './Utils'
import querystring from 'querystring'
import {URL} from 'url'

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL
const DEF_TOKEN_EXPIRY = 60 // in minutes

export class AuthenticationController {
    protected refreshToken: string = process.env.SERVICE_REFRESH_TOKEN
    protected publicKey: Buffer
    protected cache = new NodeCache ({ stdTTL: DEF_TOKEN_EXPIRY*60 - 1 }) // expire one second before actual expiry
    
    async init () {
        const url = new URL('public/public.pem', AUTH_SERVICE_URL)
        const response = await got.get(url)
        this.publicKey = response.rawBody
    }
    async authenticate (token: string): Promise<APIUser> {
        const user: any = JWT.verify (token, this.publicKey, { algorithms: [ 'ES256' ] })
        return {
            id: user.user.id,
            teamId: user.user.teamId,
            token: token,
        }
    }
    @Cache (teamId => teamId, 'cache')
    async getToken (teamId: string): Promise<string> {
        const url = new URL('oauth/token', AUTH_SERVICE_URL)
        const requestBody = {
            refresh_token: this.refreshToken,
            team_id: teamId,
            grant_type: 'refresh_token',
            expiration: DEF_TOKEN_EXPIRY
        }
        const response = await got.post (url, { body: querystring.encode (requestBody), headers: { 'content-type': 'application/x-www-form-urlencoded' } })
        const responseJSON = JSON.parse (response.body)
        return responseJSON.accessToken as string
    }
}