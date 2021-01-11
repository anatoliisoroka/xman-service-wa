import { ProxyAgent } from "@adiwajshing/baileys"

export class ProxyFactory {
    proxies: string[] = [ process.env.LUMINATI_PROXY_URL ]
    interval

    async init () {
        
    }
    close () {
        this.interval && clearInterval (this.interval)
    }
    getAgent () {
        const proxy = this.proxies[ Math.floor(Math.random()*this.proxies.length) ]
        return proxy && ProxyAgent (proxy)
    }
}