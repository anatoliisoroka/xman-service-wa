import * as QR from 'qrcode-terminal'
import { MessageLogLevel, toNumber } from "@adiwajshing/baileys"
import { WAConnection } from '../WAConnection/WAConnection'
import { FileStore } from "./FileStore"
import { WACompleteMessage } from "../Internal/Constants"
import assert from 'assert'

export const TEST_JID = '919646328797@s.whatsapp.net'

export const textMessageTemplate = async (conn: WAConnection, text: string, timestamp?: Date) => {
    const message = await conn.prepareMessageFromContent (
                        TEST_JID, 
                        { extendedTextMessage: { text } }, 
                        { timestamp }
                    ) as WACompleteMessage
    if (timestamp) message.scheduled = true
    return message
}

export const describeWithConnection = (name: string, waitForOpen: boolean, func: (conn: WAConnection) => void) => (
    describe(name, () => {
        const conn = new WAConnection()
        conn.logLevel = MessageLogLevel.info

        before(async () => {
            await conn.init ( new FileStore ('adhiraj') )
            if (!conn.currentState().canLogin) {
                conn.on ('qr', qr => QR.generate(qr, {small: true}))
                conn.connect ()
            }
            if (waitForOpen) {
                await new Promise (resolve => conn.on('open', resolve))
                assertChatDBIntegrity (conn)
            }
        })
        after(() => conn.close())
        
        func(conn)
    })
)

export const assertChatDBIntegrity = (conn: WAConnection) => {
    conn.chats.all ().forEach (chat => assertMessagesIntegrity(chat.messages))
}
export const assertMessagesIntegrity = (messages: WACompleteMessage[]) => {
    
    assert.deepEqual (
        [...messages].sort ((m1, m2) => (
            toNumber(m1.messageTimestamp)-toNumber(m2.messageTimestamp)
        )).map (m => m.key.id),
        messages.map (m => m.key.id)
    )
    assert.deepEqual (
        messages.filter (m => messages.filter(m1 => m1.key.id === m.key.id).length > 1),
        []
    )
}

export const generateJids = (length: number) => [...Array(length)].map (() => `11${Math.round(Math.random()*1000000000)}@s.whatsapp.net`)
