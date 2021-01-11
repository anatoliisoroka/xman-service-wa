import * as Sentry from '@sentry/node'
import { Integrations } from "@sentry/tracing"
import {runApp} from './Routes'

Sentry.init ({ 
    dsn: "https://674463e9949244a4b19103770429770a@o439875.ingest.sentry.io/5407382",
    integrations: [
        new Integrations.BrowserTracing(),
        new Sentry.Integrations.Http({ tracing: true }),
        new Sentry.Integrations.OnUnhandledRejection({
            mode: 'warn'
          })
    ],
    // Set tracesSampleRate to 1.0 to capture 100%
    // of transactions for performance monitoring.
    // We recommend adjusting this value in production
    tracesSampleRate: 0.3,
})
process.on('unhandledRejection', error => Sentry.captureException(error))
runApp ()