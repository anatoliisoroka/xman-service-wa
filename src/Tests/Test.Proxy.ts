require ('dotenv').config()
import fs from 'fs/promises'
import got from 'got'
import assert from 'assert'
import { obfuscatedID, generateUUID } from '../Internal/Utils'
import { ProxyFactory } from '../Internal/ProxyFactory'

describe ('Store', () => {
    const factory = new ProxyFactory ()
    before (async () => {
        await factory.init ()
    })
    after (() => factory.close())
    it ('should have proxies', async () => {
        assert.ok ( factory.proxies.length >= 1 )
        const agents = [...Array(10)].map (() => factory.getAgent())
        assert.notEqual (agents.filter(item => !!item), [])
    })
})