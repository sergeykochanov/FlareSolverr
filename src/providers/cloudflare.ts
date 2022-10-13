import {Page, HTTPResponse, TimeoutError} from 'puppeteer'

import log from "../services/log";

/**
 *  This class contains the logic to solve protections provided by CloudFlare
 **/

const BAN_SELECTORS: string[] = [
  'div.main-wrapper div.header.section h1 span.code-label span' // CloudFlare
];
const CHALLENGE_SELECTORS: string[] = [
    // todo: deprecate  '#trk_jschal_js', '#cf-please-wait'
    '#cf-challenge-running', '#trk_jschal_js', '#cf-please-wait', // CloudFlare
    '#link-ddg', // DDoS-GUARD
    'td.info #js_info' // Custom CloudFlare for EbookParadijs, Film-Paleis, MuziekFabriek and Puur-Hollands
];
const CAPTCHA_SELECTORS: string[] = [
    // todo: deprecate 'input[name="cf_captcha_kind"]'
    '#cf-challenge-hcaptcha-wrapper', '#cf-norobot-container', 'input[name="cf_captcha_kind"]'
];

const TOKEN_INPUT_NAMES = ['g-recaptcha-response', 'h-captcha-response'];

export default async function resolveChallenge(url: string, page: Page, response: HTTPResponse): Promise<HTTPResponse> {

  // look for challenge and return fast if not detected
  let cfDetected = response.headers().server &&
      (response.headers().server.startsWith('cloudflare') || response.headers().server.startsWith('ddos-guard'));
  if (cfDetected) {
    if (response.status() == 403 || response.status() == 503) {
      cfDetected = true; // Defected CloudFlare and DDoS-GUARD
    } else if (response.headers().vary && response.headers().vary.trim() == 'Accept-Encoding,User-Agent' &&
        response.headers()['content-encoding'] && response.headers()['content-encoding'].trim() == 'br') {
      cfDetected = true; // Detected Custom CloudFlare for EbookParadijs, Film-Paleis, MuziekFabriek and Puur-Hollands
    } else {
      cfDetected = false;
    }
  }

  if (cfDetected) {
    log.info('Cloudflare detected');
  } else {
    log.info('Cloudflare not detected');
    return response;
  }

  if (await findAnySelector(page, BAN_SELECTORS)) {
    throw new Error('Cloudflare has blocked this request. Probably your IP is banned for this site, check in your web browser.');
  }

  // find Cloudflare selectors
  let selectorFound = false;
  let selector: string = await findAnySelector(page, CHALLENGE_SELECTORS)
  if (selector) {
    selectorFound = true;
    log.debug(`Javascript challenge element '${selector}' detected.`)
    log.debug('Waiting for Cloudflare challenge...')

    while (true) {
      try {

        selector = await findAnySelector(page, CHALLENGE_SELECTORS)
        if (!selector) {
          // solved!
          log.debug('Challenge element not found')
          break

        } else {
          log.debug(`Javascript challenge element '${selector}' detected.`)

          // check for CAPTCHA challenge
          if (await findAnySelector(page, CAPTCHA_SELECTORS)) {
            // captcha detected
            break
          }
        }
        log.debug('Found challenge element again')

      } catch (error)
      {
        log.debug("Unexpected error: " + error);
        if (!error.toString().includes("Execution context was destroyed")) {
          break
        }
      }

      log.debug('Waiting for Cloudflare challenge...')
      await page.waitForTimeout(1000)
    }

    log.debug('Validating HTML code...')
  } else {
    log.debug(`No challenge element detected.`)
  }

  // check for CAPTCHA challenge
  let captchaSelector = await findAnySelector(page, CAPTCHA_SELECTORS)
  if (captchaSelector) {
    log.info('CAPTCHA challenge detected');

    const captchaStartTimestamp = Date.now()
    const challengeForm = await page.$('#challenge-form')
    if (challengeForm) {
      log.html(await page.content())
      const captchaTypeElm = await page.$(captchaSelector)
      const cfCaptchaType: string = await captchaTypeElm.evaluate((e: any) => e.value)
      log.info('CAPTCHA type is ' + cfCaptchaType);

      // TODO: solve captcha
      let token = 12345;

      for (const name of TOKEN_INPUT_NAMES) {
        const input = await page.$(`textarea[name="${name}"]`)
        if (input) { await input.evaluate((e: HTMLTextAreaElement, token) => { e.value = token }, token) }
      }

      // ignore preset event listeners on the form
      await page.evaluate(() => {
        window.addEventListener('submit', (e) => { event.stopPropagation() }, true)
      })

      // it seems some sites obfuscate their challenge forms
      // TODO: look into how they do it and come up with a more solid solution
      try {
        // this element is added with js and we want to wait for all the js to load before submitting
        await page.waitForSelector('#challenge-form [type=submit]', { timeout: 5000 })
      } catch (err) {
        if (err instanceof TimeoutError) {
          log.debug(`No '#challenge-form [type=submit]' element detected.`)
        }
      }

      // calculates the time it took to solve the captcha
      const captchaSolveTotalTime = Date.now() - captchaStartTimestamp

      // generates a random wait time
      const randomWaitTime = (Math.floor(Math.random() * 20) + 10) * 1000

      // waits, if any, time remaining to appear human but stay as fast as possible
      const timeLeft = randomWaitTime - captchaSolveTotalTime
      if (timeLeft > 0) { await page.waitFor(timeLeft) }

      // submit captcha response
      challengeForm.evaluate((e: HTMLFormElement) => e.submit())
      response = await page.waitForNavigation({ waitUntil: 'domcontentloaded' })

      throw new Error('Captcha detected but no automatic solver is configured.');

    }

    // const captchaSolver = getCaptchaSolver()
    // if (captchaSolver) {
    //     // to-do: get the params
    //     log.info('Waiting to receive captcha token to bypass challenge...')
    //     const token = await captchaSolver({
    //       url,
    //       sitekey,
    //       type: captchaType
    //     })
    //     log.debug(`Token received: ${token}`);
    //     // to-do: send the token
    //   }
    // } else {
    //   throw new Error('Captcha detected but no automatic solver is configured.');
    // }
  } else {
    if (!selectorFound)
    {
      throw new Error('No challenge selectors found, unable to proceed.')
    } else {
      log.info('Challenge solved');
    }
  }

  return response;
}

async function findAnySelector(page: Page, selectors: string[]) {
  for (const selector of selectors) {
    const cfChallengeElem = await page.$(selector)
    if (cfChallengeElem) {
      return selector;
    }
  }
  return null;
}
