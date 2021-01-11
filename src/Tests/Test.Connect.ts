import assert from 'assert'
import { delay } from "@adiwajshing/baileys";
import * as QR from 'qrcode-terminal'

import { describeWithServer, request, currentState } from "./Common";
import { WAState } from "../Internal/Constants";

describeWithServer ('WA Connect', closeApp => {

    const logout = async () => {
        const oldState = await currentState ()
        if (oldState.canLogin) {
            await request ('/logout')
            const newState = await currentState ()
            assert.equal (newState.connections.waWeb, 'close')
            assert.equal (newState.canLogin, false)
        }
    }
    // connects without live connection
    it ('should open a new connection', async () => {
        await logout ()

        const conn = request ('/open')
        
        await delay (3500) // wait for a few seconds
        const {pendingQR} = await currentState () // get pending QR

        assert.ok (pendingQR)

        console.log ('pls scan QR')

        QR.generate (pendingQR, {small: true})

        const state: WAState = await conn
        
        assert.ok (state)
        assert.ok (state.user)
        assert.ok (state.user.jid)

        await delay (2000)
    })

})