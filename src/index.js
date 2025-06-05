import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
import waitFor, { TimeoutError } from 'p-wait-for'
import pRetry from 'p-retry'
const log = Minilog('ContentScript')
Minilog.enable('sfrCCC')

const BASE_CLIENT_URL = 'https://espace-client.sfr.fr'
const CLIENT_SPACE_URL = 'https://www.sfr.fr/mon-espace-client/'
const HOMEPAGE_URL =
  'https://www.sfr.fr/mon-espace-client/#sfrclicid=EC_mire_Me-Connecter'
const PERSONAL_INFOS_URL =
  'https://espace-client.sfr.fr/infospersonnelles/contrat/informations/'
const LOGOUT_SELECTOR = 'a[href*="openid-connect/logout'
class SfrContentScript extends ContentScript {
  // ////////
  // PILOT //
  // ////////

  async onWorkerReady() {
    await this.waitForElementNoReload('#loginForm')
    this.watchLoginForm.bind(this)()
  }

  onWorkerEvent({ event, payload }) {
    if (event === 'loginSubmit') {
      this.log('info', `User's credential intercepted`)
      const { login, password } = payload
      this.store.userCredentials = { login, password }
    }
  }

  watchLoginForm() {
    this.log('info', '📍️ watchLoginForm starts')
    const loginField = document.querySelector('#username')
    const passwordField = document.querySelector('#password')
    if (loginField && passwordField) {
      this.log('info', 'Found credentials fields, adding form listener')
      const loginForm = document.querySelector('#loginForm')
      loginForm.addEventListener('submit', () => {
        const login = loginField.value
        const password = passwordField.value
        const event = 'loginSubmit'
        const payload = { login, password }
        this.bridge.emit('workerEvent', {
          event,
          payload
        })
      })
    }
  }

  async ensureAuthenticated() {
    this.log('info', '🤖 ensureAuthenticated starts')
    await this.goto(CLIENT_SPACE_URL)
    await Promise.race([
      this.waitForElementInWorker('#username'),
      // Selector for contract details info (name and last bill) on landing page
      this.waitForElementInWorker('[class="bloc droit"]'),
      this.runInWorkerUntilTrue({ method: 'waitForRedUrl' })
    ])
    const auth = await this.runInWorker('checkAuthenticated')
    const credentials = await this.getCredentials()
    if (auth && credentials) {
      const { sfrMLS } = await this.runInWorker(
        'checkPersonnalInfosLinkAvailability'
      )
      if (sfrMLS === credentials.sfrMLS) {
        this.log('info', 'Expected user already logged, continue')
        return true
      }
    }
    await pRetry(this.ensureNotAuthenticated.bind(this), {
      retries: 3,
      onFailedAttempt: error => {
        this.log(
          'info',
          `Logout attempt ${error.attemptNumber} failed. There are ${error.retriesLeft} retries left.`
        )
      }
    })
    await this.waitForUserAuthentication()
  }

  async navigateToNextContract(contract) {
    this.log(
      'info',
      `📍️ navigateToNextContract starts for ${JSON.stringify(contract.text)}`
    )
    // Removing elements here is to ensure we're not finding the awaited elements
    // before the next contract is loaded
    if (await this.isElementInWorker('#plusFac')) {
      await this.evaluateInWorker(function removeElement() {
        document.querySelector('#lastFacture').remove()
      })
    } else {
      await this.evaluateInWorker(function removeElement() {
        document.querySelector('div[class="sr-inline sr-xs-block "]').remove()
      })
    }
    await this.runInWorker('click', `li[id='${contract.id}']`)
    await Promise.race([
      this.waitForElementInWorker('div[class="sr-inline sr-xs-block"]'),
      this.waitForElementInWorker('div[class="sr-inline sr-xs-block "]'),
      this.waitForElementInWorker('#lastFacture')
    ])
  }

  async ensureRedNotAuthenticated() {
    this.log('info', '🤖 ensureRedNotAuthenticated starts')
    await this.runInWorker(
      'click',
      'a[href="https://www.sfr.fr/auth/realms/sfr/protocol/openid-connect/logout?redirect_uri=https%3A//www.sfr.fr/cas/logout%3Fred%3Dtrue%26url%3Dhttps://www.red-by-sfr.fr"]'
    )
    await sleep(3)
    // Sometimes the logout lead you to sfr's website, so we cover both possibilities just in case.
    await Promise.race([
      this.waitForElementInWorker(
        'a[href="https://www.red-by-sfr.fr/mon-espace-client/?casforcetheme=espaceclientred#redclicid=X_Menu_EspaceClient"]'
      ),
      this.waitForElementInWorker(
        'a[href="https://www.sfr.fr/mon-espace-client/"]'
      )
    ])
    return true
  }

  async ensureNotAuthenticated() {
    this.log('info', '🤖 ensureNotAuthenticated starts')
    await this.goto(CLIENT_SPACE_URL)
    await sleep(1) // let some time to start the load of the next page
    await Promise.race([
      this.waitForElementInWorker('#username'),
      // Selector for contract details info (name and last bill) on landing page
      this.waitForElementInWorker('[class="bloc droit"]'),
      this.runInWorkerUntilTrue({ method: 'waitForRedUrl' })
    ])

    const isRed = await this.runInWorker('isRedUrl')
    if (isRed) {
      this.log('info', 'Found red url. Running ensureRedNotAuthenticated')
      await this.ensureRedNotAuthenticated()
      await this.goto(CLIENT_SPACE_URL)
      await Promise.race([
        this.waitForElementInWorker('#username'), // SFR Login form
        this.waitForElementInWorker('label[title=Client]'),
        this.runInWorkerUntilTrue({ method: 'waitForRedUrl' })
      ])
      return true
    }

    const authenticated = await this.runInWorker('checkAuthenticated')
    if (authenticated === false) {
      this.log('info', 'SFR Login form detected')
      return
    } else {
      this.log('info', 'SFR Already logged, logging out, go to form')
      await this.runInWorker(
        'click',
        'a[href="https://www.sfr.fr/auth/realms/sfr/protocol/openid-connect/logout?redirect_uri=https%3A//www.sfr.fr/cas/logout%3Furl%3Dhttps%253A//www.sfr.fr/"]'
      )
      await sleep(3)
      await this.waitForElementInWorker(
        'a[href="https://www.sfr.fr/mon-espace-client/"]'
      )
      await this.goto(CLIENT_SPACE_URL)
      await this.waitForElementInWorker('#username')
      return
    }
  }

  async waitForUserAuthentication() {
    this.log('info', '🤖 waitForUserAuthentication starts')

    const credentials = await this.getCredentials()
    if (credentials) {
      this.log(
        'debug',
        'found credentials, filling fields and waiting for captcha resolution'
      )
      const loginFieldSelector = '#username'
      const passwordFieldSelector = '#password'
      await this.runInWorker('fillText', loginFieldSelector, credentials.login)
      await this.runInWorker(
        'fillText',
        passwordFieldSelector,
        credentials.password
      )
    }

    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({ method: 'waitForAuthenticated' })
    await this.setWorkerState({ visible: false })
  }

  async getUserDataFromWebsite() {
    this.log('info', '🤖 getUserDataFromWebsite starts')
    const credentials = await this.getCredentials()
    const storeLogin = this.store.userCredentials?.login
    await this.waitForElementInWorker(`a[href="${PERSONAL_INFOS_URL}"]`)
    const { element, sfrMLS } = await this.runInWorker(
      'checkPersonnalInfosLinkAvailability'
    )
    this.store.sfrMLS = sfrMLS
    if (!element) {
      this.log(
        'warn',
        'Access to personnal infos page is not allowed for this contract, skipping identity scraping'
      )
      return {
        sourceAccountIdentifier: credentials?.login || storeLogin
      }
    }
    this.log('info', 'personnalInfoLink visible')
    await this.runInWorker('click', `a[href="${PERSONAL_INFOS_URL}"]`)
    await Promise.race([
      this.waitForElementInWorker('#emailContact'),
      this.runInWorkerUntilTrue({ method: 'checkPersonnalInfosPageError' })
    ])
    if (this.store.infoPageError) {
      let message =
        this.store.infoPageError === 'error'
          ? 'website is showing an error'
          : "user's offer is not authorized to access this page"
      this.log(
        'warn',
        `Can not access personnal info page, ${message}. Skipping identity scraping`
      )
      return {
        sourceAccountIdentifier: credentials?.login || storeLogin
      }
    }
    const sourceAccountId = await this.runInWorker('getUserMail')
    await this.runInWorker('getUserIdentity')
    if (sourceAccountId === 'UNKNOWN_ERROR') {
      this.log('debug', "Couldn't get a sourceAccountIdentifier")
      throw new Error('Could not get a sourceAccountIdentifier')
    }
    return {
      sourceAccountIdentifier: sourceAccountId
    }
  }

  async fetch(context) {
    this.log('info', '🤖 fetch starts')
    if (this.store.userCredentials) {
      // Usefull to avoid logout if not needed
      this.store.userCredentials.sfrMLS = this.store.sfrMLS
      await this.saveCredentials(this.store.userCredentials)
    }
    if (this.store.userIdentity) {
      await this.saveIdentity(this.store.userIdentity)
    }
    await this.goto(CLIENT_SPACE_URL)
    await this.waitForElementInWorker(
      `a[href='https://espace-client.sfr.fr/gestion-ligne/lignes/ajouter']`
    )
    const contracts = await this.runInWorker('getContracts')
    let isFirstContract = true
    await this.goto(CLIENT_SPACE_URL)
    await this.waitForElementInWorker(
      `a[href='https://espace-client.sfr.fr/gestion-ligne/lignes/ajouter']`
    )
    for (const contract of contracts) {
      const contractName = contract.text
      if (contract.id !== 'current') {
        await this.navigateToNextContract(contract)
      }
      await this.fetchCurrentContractBills(
        contractName,
        context,
        isFirstContract
      )
      isFirstContract = false
    }
  }

  async fetchCurrentContractBills(contractName, context, isFirst) {
    this.log('info', '🤖 Fetching current contract: ' + contractName)
    if (isFirst) {
      let billsUrlSelector
      const landlineUrl =
        'https://espace-client.sfr.fr/facture-fixe/consultation'
      const mobileUrl =
        'https://espace-client.sfr.fr/facture-mobile/consultation'
      if (await this.isElementInWorker(`a[href="${landlineUrl}"]`)) {
        this.log('info', 'landline contract selector found')
        billsUrlSelector = `a[href="${landlineUrl}"]`
      } else if (await this.isElementInWorker(`a[href="${mobileUrl}"]`)) {
        this.log('info', 'mobile contract selector found')
        billsUrlSelector = `a[href="${mobileUrl}"]`
      } else {
        this.log('warn', 'No link to bills page found')
      }
      await this.runInWorker('click', billsUrlSelector)
    }
    await Promise.race([
      this.waitForElementInWorker('#blocAjax'),
      this.waitForElementInWorker('#historique'),
      this.waitForElementInWorker('h1', {
          includesText: 'information facture indisponible'
        })
    ])
    this.log('info', 'Checking for bills availability')
      if (
        await this.isElementInWorker('h1', {
          includesText: 'information facture indisponible'
        })
      ) {
        this.log(
          'warn',
          'Bills information are not available, ending execution'
        )
        throw new Error('VENDOR_DOWN')
      }
    this.log('info', 'Bills available, fetching them ...')
    const altButton = await this.isElementInWorker('#plusFac')
    const normalButton = await this.isElementInWorker(
      'button[onclick="plusFacture(); return false;"]'
    )
    if (altButton || normalButton) {
      await this.runInWorker('getMoreBills')
    }
    await this.runInWorker('getBills', contractName)
    const ispInvoices = []
    const phoneInvoices = []
    for (const bill of this.store.allBills) {
      if (bill.subPath.match(/^(06|07)/g)) {
        phoneInvoices.push(bill)
      } else {
        ispInvoices.push(bill)
      }
    }
    if (ispInvoices.length) {
      this.log('info', 'Saving isp invoices ...')
      await this.saveBills(ispInvoices, {
        context,
        fileIdAttributes: ['subPath', 'filename'],
        contentType: 'application/pdf',
        qualificationLabel: 'isp_invoice'
      })
    }
    if (phoneInvoices.length) {
      this.log('info', 'Saving phone invoices')
      await this.saveBills(phoneInvoices, {
        context,
        fileIdAttributes: ['subPath', 'filename'],
        contentType: 'application/pdf',
        qualificationLabel: 'phone_invoice'
      })
    }
  }

  // ////////
  // WORKER//
  // ////////

  isRedUrl() {
    const currentUrl = window.location.href
    const isRedLoginForm = currentUrl.includes(
      'service=https%3A%2F%2Fwww.red-by-sfr.fr'
    )
    const isRedEspaceClient = currentUrl.includes(
      'www.red-by-sfr.fr/mon-espace-client'
    )
    const result = isRedLoginForm || isRedEspaceClient
    return result
  }

  async waitForRedUrl() {
    this.log('info', '📍️ waitForRedUrl starts')
    await waitFor(this.isRedUrl, {
      interval: 100,
      timeout: {
        milliseconds: 10000,
        message: new TimeoutError('waitForRedUrl timed out after 10sec')
      }
    })
    return true
  }

  async checkAuthenticated() {
    if (
      document.location.href === HOMEPAGE_URL &&
      document.querySelector(`${LOGOUT_SELECTOR}`)
    ) {
      this.log('info', 'Auth Check succeeded')
      return true
    }
    if (
      document.location.href === CLIENT_SPACE_URL &&
      document.querySelector(`${LOGOUT_SELECTOR}`)
    ) {
      this.log('info', 'Session found, returning true')
      return true
    }
    return false
  }

  async getUserMail() {
    this.log('info', '📍️ getUserMail starts')
    const userMailElement = document.querySelector('#emailContact').innerHTML
    if (userMailElement) {
      return userMailElement
    }
    return 'UNKNOWN_ERROR'
  }

  async getUserIdentity() {
    this.log('debug', 'getUserIdentity starts')
    const givenName = document
      .querySelector('#nomTitulaire')
      .innerHTML.split(' ')[0]
    const familyName = document
      .querySelector('#nomTitulaire')
      .innerHTML.split(' ')[1]
    const address = document
      .querySelector('#adresseContact')
      .innerHTML.replace(/\t/g, ' ')
      .replace(/\n/g, '')
    const unspacedAddress = address
      .replace(/(\s{2,})/g, ' ')
      .replace(/^ +/g, '')
      .replace(/ +$/g, '')
    const addressNumbers = unspacedAddress.match(/([0-9]{1,})/g)
    const houseNumber = addressNumbers[0]
    const postCode = addressNumbers[1]
    const addressWords = unspacedAddress.match(/([A-Z ]{1,})/g)
    const street = addressWords[0].replace(/^ +/g, '').replace(/ +$/g, '')
    const city = addressWords[1].replace(/^ +/g, '').replace(/ +$/g, '')
    const mobilePhoneNumber = document
      .querySelector('#telephoneContactMobile')
      .innerHTML.trim()
    let homePhoneNumber = null
    if (document.querySelector('#telephoneContactFixe')) {
      homePhoneNumber = document
        .querySelector('#telephoneContactFixe')
        .innerHTML.trim()
    }
    const email = document.querySelector('#emailContact').innerHTML
    const userIdentity = {
      email,
      name: {
        givenName,
        familyName,
        fullname: `${givenName} ${familyName}`
      },
      address: [
        {
          formattedAddress: unspacedAddress,
          houseNumber,
          postCode,
          city,
          street
        }
      ],
      phone: [
        {
          type: 'mobile',
          number: mobilePhoneNumber
        }
      ]
    }
    if (homePhoneNumber !== null) {
      userIdentity.phone.push({
        type: 'home',
        number: homePhoneNumber
      })
    }
    await this.sendToPilot({ userIdentity })
  }

  async getContracts() {
    this.log('info', '📍️ getContracts starts')
    const contracts = Array.from(
      document.querySelectorAll(`body > nav > ul > li`)
    )
      .filter(el =>
        el.querySelector('a').getAttribute('href').startsWith('?e=')
      )
      .map(el => {
        const lineNumber = el.querySelector('h4').textContent.trim()
        const contractStatus = el.querySelector('p').textContent.trim()
        const text = `${lineNumber} ${contractStatus}`
        let type
        if (text.startsWith('06') || text.startsWith('07')) {
          type = 'mobile'
        } else {
          type = 'fixe'
        }
        return {
          // No more "id" attributes available, got to find it in the href
          id:
            el.querySelector('a').getAttribute('href').split('?e=')[1] ||
            'current',
          text,
          type
        }
      })
    return contracts
  }

  async getCurrentContract() {
    this.log('info', '📍️ getCurrentContract starts')
    try {
      const contracts = await this.getContracts()
      const currentContract = contracts.find(
        contract => contract.id === 'current'
      )
      return currentContract
    } catch (err) {
      this.log(
        'debug',
        `Error while trying to get current contract ${err.message}`
      )
      return false
    }
  }

  async getMoreBills() {
    this.log('info', '📍️ getMoreBills starts')
    const moreBillsSelector = 'button[onclick="plusFacture(); return false;"]'
    const moreBillAltWrapperSelector = '#plusFacWrap'
    const moreBillAltSelector = '#plusFac'
    if (document.querySelector(moreBillsSelector)) {
      while (document.querySelector(`${moreBillsSelector}`) !== null) {
        this.log('debug', 'moreBillsButton detected, clicking')
        const moreBillsButton = document.querySelector(`${moreBillsSelector}`)
        moreBillsButton.click()
        // Here, we need to wait for the older bills to load on the page
        await sleep(3)
      }
    }
    if (
      document.querySelector(moreBillAltSelector) &&
      document.querySelector(moreBillAltWrapperSelector)
    ) {
      while (
        !document
          .querySelector(`${moreBillAltWrapperSelector}`)
          .getAttribute('style')
      ) {
        this.log('debug', 'moreBillsButton detected, clicking')
        const moreBillsButton = document.querySelector(`${moreBillAltSelector}`)
        moreBillsButton.click()
        // Here, we need to wait for the older bills to load on the page
        await sleep(3)
      }
    }
    this.log('debug', 'No more moreBills button')
  }

  async getBills(contractName) {
    this.log('info', '📍️ getBills starts')
    let lastBill
    let allBills
    // Selector of the alternative lastBill element
    if (document.querySelector('#lastFacture')) {
      lastBill = await this.findAltLastBill(contractName)
      this.log('debug', 'Last bill returned, getting old ones')
      const oldBills = await this.findAltOldBills(contractName)
      allBills = lastBill.concat(oldBills)
      this.log('debug', 'Old bills returned, sending to Pilot')
    } else {
      lastBill = await this.findLastBill(contractName)
      this.log('debug', 'Last bill returned, getting old ones')
      const oldBills = await this.findOldBills(contractName)
      allBills = lastBill.concat(oldBills)
      this.log('debug', 'Old bills returned, sending to Pilot')
    }
    await this.sendToPilot({
      allBills
    })
    this.log('debug', 'getBills done')
  }

  async findLastBill(contractName) {
    this.log('info', '📍️ findLastBill starts')
    let lastBill = []
    const lastBillElement = document.querySelector(
      'div[class="sr-inline sr-xs-block "]'
    )
    this.log(
      'info',
      `lastBillElement : ${JSON.stringify(Boolean(lastBillElement))}`
    )
    if (
      lastBillElement.innerHTML.includes('à partir du') ||
      !lastBillElement.innerHTML.includes('Payé le')
    ) {
      this.log(
        'info',
        'This bill has no dates to fetch yet, fetching it when dates has been given'
      )
      return []
    }
    const rawAmount = lastBillElement
      .querySelectorAll('div')[0]
      .querySelector('span').innerHTML
    const fullAmount = rawAmount
      .replace(/&nbsp;/g, '')
      .replace(/ /g, '')
      .replace(/\n/g, '')
    const amount = parseFloat(fullAmount.replace('€', '').replace(',', '.'))
    const currency = fullAmount.replace(/[0-9]*/g, '')
    const rawDate = lastBillElement
      .querySelectorAll('div')[1]
      .querySelectorAll('span')[1].innerHTML
    const dateArray = rawDate.split('/')
    const day = dateArray[0]
    const month = dateArray[1]
    const year = dateArray[2]
    const rawPaymentDate = lastBillElement
      .querySelectorAll('div')[1]
      .querySelectorAll('span')[0].innerHTML
    const paymentArray = rawPaymentDate.split('/')
    const paymentDay = paymentArray[0]
    const paymentMonth = paymentArray[1]
    const paymentYear = paymentArray[2]
    const filepath = lastBillElement
      .querySelector('#lien-telecharger-pdf')
      .getAttribute('href')
    const fileurl = `${BASE_CLIENT_URL}${filepath}`
    const computedLastBill = {
      amount,
      currency: currency === '€' ? 'EUR' : currency,
      date: new Date(`${month}/${day}/${year}`),
      paymentDate: new Date(`${paymentMonth}/${paymentDay}/${paymentYear}`),
      filename: await getFileName(`${year}/${month}/${day}`, amount, currency),
      fileurl,
      vendor: 'sfr',
      subPath: contractName,
      fileAttributes: {
        metadata: {
          contentAuthor: 'sfr',
          datetime: new Date(`${month}/${day}/${year}`),
          datetimeLabel: 'issueDate',
          isSubscription: true,
          issueDate: new Date(`${month}/${day}/${year}`),
          carbonCopy: true
        }
      }
    }
    if (
      lastBillElement.querySelectorAll('[id*="lien-telecharger-"]').length > 1
    ) {
      const detailedFilepath = lastBillElement
        .querySelector('[id*="lien-telecharger-fadet"]')
        .getAttribute('href')
      const detailed = detailedFilepath.match('detail') ? true : false
      const detailedBill = {
        ...computedLastBill
      }
      detailedBill.filename = await getFileName(
        `${year}/${month}/${day}`,
        amount,
        currency,
        detailed
      )
      detailedBill.fileurl = `${BASE_CLIENT_URL}${detailedFilepath}`
      lastBill.push(detailedBill)
    }
    lastBill.push(computedLastBill)
    return lastBill
  }

  async findAltLastBill(contractName) {
    this.log('info', '📍️ findAltLastBill starts')
    let lastBill = []
    const lastBillElement = document.querySelector(
      'div[class="sr-inline sr-xs-block"]'
    )
    const rawAmount = lastBillElement
      .querySelectorAll('div')[0]
      .querySelector('span').innerHTML
    const fullAmount = rawAmount
      .replace(/&nbsp;/g, '')
      .replace(/ /g, '')
      .replace(/\n/g, '')
    const amount = parseFloat(fullAmount.replace('€', '').replace(',', '.'))
    const currency = fullAmount.replace(/[0-9]*/g, '').replace(',', '')
    const rawDate = lastBillElement
      .querySelectorAll('div')[1]
      .querySelectorAll('div')[1].innerHTML
    const dateArray = rawDate.split('/')
    const day = dateArray[0].split('du')[1].trim()
    const month = dateArray[1].trim()
    const year = dateArray[2].trim()
    const filepath = lastBillElement.querySelector('a').getAttribute('href')
    const fileurl = `${BASE_CLIENT_URL}${filepath}`
    const computedLastBill = {
      amount,
      currency: currency === '€' ? 'EUR' : currency,
      date: new Date(`${month}/${day}/${year}`),
      filename: await getFileName(`${year}-${month}-${day}`, amount, currency),
      fileurl,
      vendor: 'sfr',
      subPath: contractName,
      fileAttributes: {
        metadata: {
          contentAuthor: 'sfr',
          datetime: new Date(`${month}/${day}/${year}`),
          datetimeLabel: 'issueDate',
          isSubscription: true,
          issueDate: new Date(`${month}/${day}/${year}`),
          carbonCopy: true
        }
      }
    }
    if (amount !== 0) {
      const rawPaymentDate = lastBillElement
        .querySelectorAll('div')[1]
        .querySelectorAll('div')[0].innerHTML
      const paymentArray = rawPaymentDate.split('/')
      const paymentDay = paymentArray[0]
      const paymentMonth = paymentArray[1]
      const paymentYear = paymentArray[2]
      const paymentDate = new Date(
        `${paymentMonth}/${paymentDay}/${paymentYear}`
      )
      computedLastBill.paymentDate = paymentDate
    }
    lastBill.push(computedLastBill)
    return lastBill
  }

  async findOldBills(contractName) {
    this.log('info', '📍️ findOldBill starts')
    let oldBills = []
    const allBillsElements = document
      .querySelector('#blocAjax')
      .querySelectorAll('.sr-container-content-line')
    let counter = 0
    for (const oneBill of allBillsElements) {
      this.log(
        'debug',
        `fetching bill ${counter + 1}/${allBillsElements.length}...`
      )
      const rawAmount = oneBill.children[0].querySelector('span').innerHTML
      const fullAmount = rawAmount
        .replace(/&nbsp;/g, '')
        .replace(/ /g, '')
        .replace(/\n/g, '')
      const amount = parseFloat(fullAmount.replace('€', '').replace(',', '.'))
      const currency = fullAmount.replace(/[0-9]*/g, '').replace(',', '')
      const rawDate = oneBill.children[1].querySelector('span').innerHTML
      const dateArray = rawDate.split(' ')
      const day = dateArray[0]
      const month = computeMonth(dateArray[1])
      const year = dateArray[2]
      const rawPaymentDate = oneBill.children[1].innerHTML
        .replace(/\n/g, '')
        .replace(/ /g, '')
        .match(/([0-9]{2}[a-zûé]{3,4}.?-)/g)
      const filepath = oneBill
        .querySelector('[id*="lien-duplicata-pdf-"]')
        .getAttribute('href')
      const fileurl = `${BASE_CLIENT_URL}${filepath}`
      let computedBill = {
        amount,
        currency: currency === '€' ? 'EUR' : currency,
        date: new Date(`${month}/${day}/${year}`),
        filename: await getFileName(
          `${year}/${month}/${day}`,
          amount,
          currency
        ),
        fileurl,
        vendor: 'sfr',
        subPath: contractName,
        fileAttributes: {
          metadata: {
            contentAuthor: 'sfr',
            datetime: new Date(`${month}/${day}/${year}`),
            datetimeLabel: 'issueDate',
            isSubscription: true,
            issueDate: new Date(`${month}/${day}/${year}`),
            carbonCopy: true
          }
        }
      }
      // After the first year of bills, paymentDate is not given anymore
      // So we need to check if the bill has a defined paymentDate
      if (rawPaymentDate !== null) {
        const paymentDay = rawPaymentDate[0].match(/[0-9]{2}/g)
        const rawPaymentMonth = rawPaymentDate[0].match(/[a-zûé]{3,4}\.?/g)
        const paymentMonth = computeMonth(rawPaymentMonth[0])
        // Assigning the same year founded for the bill's creation date
        // as it is not provided, assuming the bill has been paid on the same year
        const paymentYear = year

        computedBill.paymentDate = new Date(
          `${paymentMonth}/${paymentDay}/${paymentYear}`
        )
      }
      if (oneBill.querySelectorAll('[id*="lien-"]').length > 1) {
        const detailedFilepath = oneBill
          .querySelector('[id*="lien-telecharger-fadet"]')
          .getAttribute('href')
        const detailed = detailedFilepath.match('detail') ? true : false
        const detailedBill = {
          ...computedBill
        }
        detailedBill.filename = await getFileName(
          `${year}/${month}/${day}`,
          amount,
          currency,
          detailed
        )
        detailedBill.fileurl = `${BASE_CLIENT_URL}${detailedFilepath}`
        oldBills.push(detailedBill)
      }
      oldBills.push(computedBill)
      counter++
    }
    this.log('debug', 'Old bills fetched')
    return oldBills
  }

  async findAltOldBills(contractName) {
    this.log('info', '📍️ findAltOldBill starts')
    let oldBills = []
    const allBillsElements = document
      .querySelector('#historique')
      .querySelectorAll('.sr-container-content-line')
    let counter = 0
    for (const oneBill of allBillsElements) {
      this.log(
        'info',
        `fetching bill ${counter + 1}/${allBillsElements.length}...`
      )
      const rawAmount = oneBill.children[0].querySelector('span').innerHTML
      const fullAmount = rawAmount
        .replace(/&nbsp;/g, '')
        .replace(/ /g, '')
        .replace(/\n/g, '')
      const amount = parseFloat(fullAmount.replace('€', '').replace(',', '.'))
      const currency = fullAmount.replace(/[0-9]*/g, '').replace(',', '')
      const datesElements = Array.from(oneBill.children).filter(
        element => element.tagName === 'SPAN'
      )
      const filepath = oneBill.querySelector('a').getAttribute('href')
      const fileurl = `${BASE_CLIENT_URL}${filepath}`
      let computedBill = {
        amount,
        currency: currency === '€' ? 'EUR' : currency,
        vendor: 'sfr',
        fileurl,
        subPath: contractName,
        fileAttributes: {
          metadata: {
            contentAuthor: 'sfr',
            datetimeLabel: 'issueDate',
            isSubscription: true,
            issueDate: new Date(),
            carbonCopy: true
          }
        }
      }

      if (datesElements.length >= 2) {
        this.log('info', 'Found a payment date')
        const rawPaymentDate =
          datesElements[0].innerHTML.match(/\d{2}\/\d{2}\/\d{4}/g)[0]
        const foundDate = rawPaymentDate.replace(/\//g, '-').trim()
        const [paymentDay, paymentMonth, paymentYear] = foundDate.split('-')
        const paymentDate = new Date(
          `${paymentMonth}/${paymentDay}/${paymentYear}`
        )
        const innerhtmlIssueDate = datesElements[1].innerHTML
        const foundIssueDate = innerhtmlIssueDate.split('-')[1].trim()
        const [issueDay, issueMonth, issueYear] = foundIssueDate.split(/\//g)
        const issueDate = new Date(`${issueMonth}/${issueDay}/${issueYear}`)
        computedBill.paymentDate = paymentDate
        computedBill.date = issueDate
        computedBill.fileAttributes.metadata.datetime = issueDate
        computedBill.filename = await getFileName(
          `${issueYear}-${issueMonth}-${issueDay}`,
          amount,
          currency
        )
      } else {
        this.log('info', 'Only one element present')
        const elementInnerhtml = datesElements[0].innerHTML
        if (elementInnerhtml.includes('Payé le')) {
          const [innerhtmlPaymentDate, innerhtmlIssueDate] =
            elementInnerhtml.split('- </span>')

          const foundPaymentDate = innerhtmlPaymentDate
            .split('le')[1]
            .replace('</span>', '')
            .trim()
          const [paymentDay, paymentMonth, paymentYear] =
            foundPaymentDate.split('/')
          const paymentDate = new Date(
            `${paymentMonth}/${paymentDay}/${paymentYear}`
          )

          const foundIssueDate = innerhtmlIssueDate
            .split('mensuelle -')[1]
            .replace('</span>', '')
            .trim()
          const [issueDay, issueMonth, issueYear] = foundIssueDate.split(/\//g)
          const issueDate = new Date(`${issueMonth}/${issueDay}/${issueYear}`)
          computedBill.paymentDate = paymentDate
          computedBill.date = issueDate
          computedBill.fileAttributes.metadata.datetime = issueDate
          computedBill.filename = await getFileName(
            `${issueYear}-${issueMonth}-${issueDay}`,
            amount,
            currency
          )
        } else {
          this.log('info', 'Element does not includes "payé le"')
          const foundIssueDate = elementInnerhtml.split('-')[1].trim()
          const [issueDay, issueMonth, issueYear] = foundIssueDate.split(/\//g)
          const issueDate = new Date(`${issueMonth}/${issueDay}/${issueYear}`)
          computedBill.date = issueDate
          computedBill.fileAttributes.metadata.datetime = issueDate
          computedBill.filename = await getFileName(
            `${issueYear}-${issueMonth}-${issueDay}`,
            amount,
            currency
          )
        }
      }
      oldBills.push(computedBill)
      counter++
    }
    this.log('debug', 'Old bills fetched')
    return oldBills
  }

  async getReloginPage() {
    this.log('info', '📍️ getReloginPage starts')
    if (document.querySelector('#password')) {
      return true
    }
    return false
  }

  async checkPersonnalInfosLinkAvailability() {
    this.log('info', '📍️ checkPersonnalInfosLinkAvailability starts')
    let sfrMLS
    const foundSfrMLS = document.cookie
      .split('; ')
      .find(row => row.startsWith('MLS='))
    if (foundSfrMLS) {
      // Sometimes value is urlEncoded, sometimes not, so we do this to ensure we're getting the right value and
      // MLS can contain "=" char in the value, doing this as the effect of a split function without risking to split de value as well
      sfrMLS = decodeURIComponent(
        foundSfrMLS.substring(foundSfrMLS.indexOf('=') + 1)
      )
    }
    const element = Boolean(
      document.querySelector(`a[href="${PERSONAL_INFOS_URL}"]`)
    )
    return { element, sfrMLS }
  }

  async checkPersonnalInfosPageError() {
    this.log('info', '📍️ checkPersonnalInfosPageError starts')
    let hasError = false
    await waitFor(
      async () => {
        const errorH1 = document.querySelector('h1')
        const nonAuthorizedH2 = document.querySelector('h2')
        if (errorH1?.textContent.includes('erreur')) {
          this.log(
            'info',
            `Error H1 found on this page : ${errorH1.textContent}`
          )
          hasError = 'error'
          return true
        }
        if (
          nonAuthorizedH2?.textContent.includes(
            'Votre offre actuelle ne vous permet pas'
          )
        ) {
          this.log(
            'infos',
            `nonAuthorized H2 found on this page : ${nonAuthorizedH2.textContent}`
          )
          hasError = 'unauthorized'
          return true
        }
        return false
      },
      {
        interval: 1000,
        timeout: 30 * 1000
      }
    )
    if (hasError) {
      await this.sendToPilot({ infoPageError: hasError })
    }
    return true
  }
}

const connector = new SfrContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'getUserMail',
      'getMoreBills',
      'getBills',
      'getReloginPage',
      'getUserIdentity',
      'getContracts',
      'waitForRedUrl',
      'isRedUrl',
      'checkPersonnalInfosLinkAvailability',
      'checkPersonnalInfosPageError'
    ]
  })
  .catch(err => {
    log.warn(err)
  })

function sleep(delay) {
  return new Promise(resolve => {
    setTimeout(resolve, delay * 1000)
  })
}

function getFileName(date, amount, currency, detailed) {
  return `${date.replace(/\//g, '-')}_sfr_${amount}${currency.replace(
    ',',
    ''
  )}${detailed ? '_detailed' : ''}.pdf`
}

function computeMonth(month) {
  let computedMonth = null
  switch (month) {
    case 'janv.':
    case 'Jan':
      computedMonth = '01'
      break
    case 'févr.':
    case 'Feb':
      computedMonth = '02'
      break
    case 'mars':
    case 'Mar':
      computedMonth = '03'
      break
    case 'avr.':
    case 'Apr':
      computedMonth = '04'
      break
    case 'mai':
    case 'May':
      computedMonth = '05'
      break
    case 'juin':
    case 'Jun':
      computedMonth = '06'
      break
    case 'juil.':
    case 'Jul':
      computedMonth = '07'
      break
    case 'août':
    case 'Aug':
      computedMonth = '08'
      break
    case 'sept.':
    case 'Sep':
      computedMonth = '09'
      break
    case 'oct.':
    case 'Oct':
      computedMonth = '10'
      break
    case 'nov.':
    case 'Nov':
      computedMonth = '11'
      break
    case 'déc.':
    case 'Dec':
      computedMonth = '12'
      break
  }
  return computedMonth
}
