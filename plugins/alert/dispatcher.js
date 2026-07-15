const http = require('http');
const https = require('https');
const { URL } = require('url');

// Пул параллелизма (семафор)
const MAX_CONCURRENT_REQUESTS = 3;
let activeRequests = 0;

/**
 * Экранирование спецсимволов для Telegram MarkdownV2
 */
function escapeMarkdownV2(text) {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

/**
 * Шаблонизатор сообщений
 */
function renderTemplate(template, context) {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        return context[key] !== undefined ? context[key] : match;
    });
}

/**
 * Выполнение HTTP-запроса с таймаутом и AbortController
 */
function makeHttpRequest(urlStr, options, payload, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const client = url.protocol === 'https:' ? https : http;
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
            controller.abort();
            reject(new Error(`Request timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        options.signal = controller.signal;

        const req = client.request(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                clearTimeout(timeoutId);
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve({ status: res.statusCode, data });
                } else {
                    reject(new Error(`HTTP Error ${res.statusCode}: ${data}`));
                }
            });
        });

        req.on('error', (err) => {
            clearTimeout(timeoutId);
            if (err.name === 'AbortError') {
                reject(new Error(`Request aborted (timeout)`));
            } else {
                reject(err);
            }
        });

        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}

/**
 * Адаптер для Telegram
 */
async function sendTelegram(config, text) {
    if (!config.bot_token || !config.chat_id) {
        throw new Error('Missing bot_token or chat_id for Telegram');
    }

    const escapedText = escapeMarkdownV2(text);
    const payload = JSON.stringify({
        chat_id: config.chat_id,
        text: escapedText,
        parse_mode: 'MarkdownV2'
    });

    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
    };

    const url = `https://api.telegram.org/bot${config.bot_token}/sendMessage`;
    await makeHttpRequest(url, options, payload);
}

/**
 * Адаптер для Webhook
 */
async function sendWebhook(config, text) {
    if (!config.url) {
        throw new Error('Missing url for Webhook');
    }

    const payload = JSON.stringify({ text });
    const options = {
        method: config.method || 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
    };
    
    if (config.headers) {
        Object.assign(options.headers, config.headers);
    }

    await makeHttpRequest(config.url, options, payload);
}

/**
 * Диспетчеризация сообщения в нужный канал
 */
async function dispatchMessage(channelType, config, text) {
    if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
        throw new Error('Max concurrent requests reached, try again later');
    }

    activeRequests++;
    try {
        switch (channelType) {
            case 'telegram':
                await sendTelegram(config, text);
                break;
            case 'webhook':
                await sendWebhook(config, text);
                break;
            default:
                throw new Error(`Unknown channel type: ${channelType}`);
        }
    } finally {
        activeRequests--;
    }
}

function getActiveRequestsCount() {
    return activeRequests;
}

module.exports = {
    dispatchMessage,
    renderTemplate,
    getActiveRequestsCount
};
