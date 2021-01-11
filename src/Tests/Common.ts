import got, { Method } from 'got'
import { runApp } from "../Routes"
import { Application } from '../App'
import { WAState } from '../Internal/Constants'
import { StoreFactory } from '../Store/StoreFactory'
import { delay } from '@adiwajshing/baileys'
import {URL} from 'url'

export const TEST_ADDR = 'http://localhost:5000'
export const TEST_TOKEN = 'cool-token'
export const TEST_JID = '919646328797@s.whatsapp.net'

export const generateJids = (length: number) => [...Array(length)].map (() => `+11${Math.round(Math.random()*1000000000)}@s.whatsapp.net`)

export const currentState = () => request ('/') as Promise<WAState>

export const request = async (path: string, method: Method = 'GET', body?: any) => {
    const url = new URL (path, TEST_ADDR)
    
    if (typeof body !== 'string') {
        body = JSON.stringify (body)
    }
    const response = await got (
        url, 
        { 
            method, 
            retry: 0, 
            throwHttpErrors: false, 
            headers: {
                'authorization': `Bearer ${TEST_TOKEN}`,
                'content-type': 'application/json'
            },
            body
        }
    )
    if (response.body.length > 0) {
        try {
            const json = JSON.parse (response.body)
            if (json.error) {
                console.error (json.error)
                throw json
            }
            return json
        } catch (error) {
            throw new Error (response.body)
        }
    } else if (response.statusCode >= 400) {
        throw new Error ('error ' + response.statusCode)
    }
}
export const waitForOpen = async () => {
    let state: WAState
    do {
        state = await currentState ()
        if (state.connections.waWeb === 'close') {
            console.log ('sent open')
            request ('/open', 'GET')
        }
        await delay (1000)
    } while (state.connections.waWeb !== 'open')
    return state
}

export const describeWithServer = (title: string, callback: (app: Application<any>) => void) =>
    describe (title, () => {
        let app: Application<any>
        before (async () => {
            const factory = new StoreFactory ()
            factory.auth.authenticate = async (token) => {
                if (token === TEST_TOKEN) {
                    return {
                        id: '1234',
                        teamId: '071dd86e-1e35-45bc-82cf-38287f703a97',
                        token: TEST_TOKEN
                    }
                }
                throw new Error ('no')
            }
            app = await runApp (factory)
            await delay (2000)
        })
        after(async () => {
            app.close ()
        })
        callback (app)
    })