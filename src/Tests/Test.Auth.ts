require ('dotenv').config()

import assert from 'assert'
import {AuthenticationController} from '../Internal/Auth'

const TEST_TEAMS = [
    'a930389a-cf88-4920-b590-650f557c4e09',
    '071dd86e-1e35-45bc-82cf-38287f703a97'
]
const FAIL_TEST_TOKENS = [
    '3d3c647e-c9bc-4596-82f6-84420f49479f',
    '3d3c641e-c9cc-4596-82f6-84420f49479f',
    'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyIjp7InRlYW0iOnsiaWQiOiJhOTMwMzg5YS1jZjg4LTQ5MjAtYjU5MC02NTBmNTU3YzRlMDkifX0sInNjb3BlIjoidGVhbV9zcGVjaWZpYyIsImV4cCI6MTU5OTk5OTQzMiwiaWF0IjoxNTk5OTk1ODMyfQ.AAAAAJxQp9PNN3khTzDKmbbAnnPfPCl_Y6_iC1MUwlwAAAAASEqv5FcfnpVaIESnUr21ud0Fg4rF9owmCiePhA' // expired token
]

describe ('Authentication', () => {
    const controller = new AuthenticationController ()

    before (async () => {
        await controller.init ()
    })
    it ('should generate tokens for a given team & succeed JWT', async () => {
        for (let team of TEST_TEAMS) {
            const token = await controller.getToken (team)
            assert.ok (token)
            const user = await controller.authenticate (token)
            assert.equal (user.teamId, team)
        }
    })
    it ('should fail', async () => {
        for (let token of FAIL_TEST_TOKENS) {
            await assert.rejects(() => controller.authenticate (token))
        }
    })
})