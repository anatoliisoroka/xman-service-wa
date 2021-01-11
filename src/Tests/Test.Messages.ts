import assert from 'assert'
import { delay, unixTimestampSeconds } from "@adiwajshing/baileys";

import { describeWithServer, request, TEST_JID, waitForOpen } from "./Common";
import { Static } from 'runtypes';
import { MessageComposeOptions } from '../Internal/Runtypes';
import { WACompleteMessage } from '../Internal/Constants';
import querystring from 'querystring'

describeWithServer ('Messages', app => {

    const textMessageTemplate = (text: string, scheduled: Date) => {
        const tmp: Static<typeof MessageComposeOptions> = {
            jid: TEST_JID,
            text,
            scheduleAt: unixTimestampSeconds (scheduled)
        }
        return tmp
    }
    const clearAllScheduledMessages = async (exceptID: string) => {
        await waitForOpen ()

        const messages: WACompleteMessage[] = (await request ('/messages/' + TEST_JID, 'GET')).messages
        const relevant = messages.filter (m => m.scheduled && m.key.id !== exceptID)

        console.log (`clearing ${relevant.length} messages`)

        await Promise.all (
            relevant.map (m => (
                request ('/messages/' + encodeURIComponent(TEST_JID) + '/' + m.key.id, 'DELETE')
            ))
        )
    }

    const scheduleMessage = async (options: any) => {
        const template = textMessageTemplate ('this will arrive soon', new Date(new Date().getTime() + 30_000))
        const encodedOpts = querystring.encode(options)
        const url = '/messages/' + encodeURIComponent(TEST_JID) + '/' + (encodedOpts ? `?${encodedOpts}` : '')
        const scheduled: WACompleteMessage = await request (url, 'POST', template)

        console.log ('scheduled message')

        await waitForOpen ()

        let {messages}: { messages: WACompleteMessage[] } = await request ('/messages/' + TEST_JID, 'GET')
        const messageIdx = messages.findIndex (m => m.key.id === scheduled.key.id)

        assert.ok (messages[messageIdx])
        assert.ok (messages[messageIdx].scheduled)
        // verify no messages are unscheduled after the scheduled message -- correct ordering
        assert.strictEqual (messages.slice(messageIdx).filter(m => !m.scheduled).length, 0)

        console.log ('verified message added')

        await delay (30_000)

        messages = (await request ('/messages/' + TEST_JID, 'GET')).messages
        const retreived = messages.find(m => m.key.id === scheduled.key.id)
        
        assert.ok (retreived)
        assert.ok (!retreived.scheduled)
        assert.ok ((retreived.messageTimestamp as number)*1000 >= (scheduled.messageTimestamp as number))
        assert.ok (unixTimestampSeconds() >= (retreived.messageTimestamp as number))
    }

    it ('should schedule a message', async () => {
        await scheduleMessage({})
    })
    it ('should schedule a message with typing', async () => {
        await scheduleMessage({ withTyping: true })
    })
    it ('should not send a duplicate message', async () => {
        await waitForOpen ()

        let {messages}: { messages: WACompleteMessage[] } = await request ('/messages/' + TEST_JID, 'GET')

        const template = textMessageTemplate ('this will arrive soon', new Date(new Date().getTime() + 30_000))
        template.tag = '1234'

        const results = await Promise.all([...Array(5)].map(() => (
            request ('/messages/' + encodeURIComponent(TEST_JID) + '/', 'POST', template)
            .catch(error => {})
        )))
        const message = results.find(r => !!r)
        assert.ok(message)

        await delay(10_000) // wait some time

        let {messages: messagesAfter}: { messages: WACompleteMessage[] } = await request ('/messages/' + TEST_JID, 'GET')
        let rMessagesIdx = messagesAfter.findIndex(m => m.key.id === messages[messages.length-1].key.id)
        let remainingMessages = messagesAfter.slice(rMessagesIdx+1)

        assert.strictEqual(remainingMessages.length, 1)
    })
    it ('should cancel a scheduled message', async () => {
        const template1 = await textMessageTemplate ('this will never arrive', new Date(new Date().getTime() + 15*1000))
        const template2 = await textMessageTemplate ('this will *probably* arrive', new Date(new Date().getTime() + 16*1000))
        
        const scheduled1: WACompleteMessage = await request ('/messages/' + encodeURIComponent(TEST_JID) + '/', 'POST', template1)
        const scheduled2: WACompleteMessage = await request ('/messages/' + encodeURIComponent(TEST_JID) + '/', 'POST', template2)

        assert.ok (scheduled1['scheduled'])

        await delay (5000)

        await request ('/messages/' + encodeURIComponent(TEST_JID) + '/' + scheduled1.key.id, 'DELETE')

        console.log ('deleted scheduled message')

        await delay (30_000) // wait for 30 seconds more to ensure that the message is not sent

        let {messages}: { messages: WACompleteMessage[] } = await request ('/messages/' + TEST_JID, 'GET')
        assert.equal (messages.find(m => m.key.id === scheduled1.key.id), undefined)

        const m2 = messages.find(m => m.key.id === scheduled2.key.id)
        assert.notEqual (m2, undefined)
        assert.equal (m2.scheduled, undefined)
    })
    it ('should reschedule a scheduled message', async () => {
        const template = textMessageTemplate ('this will arrive sooner than expected', new Date(new Date().getTime() + 25*1000))
        const newTime = (template.scheduleAt as number) - 10 // 10 seconds before

        await clearAllScheduledMessages (undefined)
        
        const scheduled1: WACompleteMessage = await request ('/messages/' + encodeURIComponent(TEST_JID) + '/', 'POST', template)
        await request ('/messages/' + encodeURIComponent(TEST_JID) + '/' + scheduled1.key.id + '/', 'PATCH', { scheduleAt: newTime })

        await delay (30_000)

        let {messages}: { messages: WACompleteMessage[] } = await request ('/messages/' + TEST_JID, 'GET')
        
        const m2 = messages.find(m => m.key.id === scheduled1.key.id)
        assert.notEqual (m2, undefined)

        assert.equal (m2.scheduled, undefined)

        const curTime = m2.messageTimestamp as number
        assert.ok (curTime < newTime+2) // should be sent at the right time
    })
    it ('should schedule multiple messages without fail', async () => {
        await request ('/messages/' + TEST_JID + '/all-pending', 'DELETE')

        const list = await Promise.all (
            [...Array(10)].map ((_, i) => (
                request (
                    '/messages/' + encodeURIComponent(TEST_JID) + '/', 
                    'POST', 
                    textMessageTemplate('My name jeff ' + i, new Date(new Date().getTime() + i*3000))
                )
            ))
        )
        let closes = 0
        let messages: WACompleteMessage[]
        do {
            messages = (await request ('/messages/' + TEST_JID, 'GET')).messages

            await delay (2_000)

            if (Math.random() < 0.333 && closes < 1) {
                console.log ('closing')

                await request ('/close', 'GET')
                await delay (5_000)

                await waitForOpen ()

                closes += 1
            }
        } while (messages.filter(m => m.scheduled).length > 0)
        
    })

})