import { ContentScript } from 'cozy-clisk/dist/contentscript'
import { blobToBase64 } from 'cozy-clisk/dist/contentscript/utils'
import ky from 'ky'
import Minilog from '@cozy/minilog'
import waitFor, { TimeoutError } from 'p-wait-for'
const log = Minilog('ContentScript')
Minilog.enable('sfrCCC')

const BASE_CLIENT_URL = 'https://espace-client.sfr.fr'
const CLIENT_SPACE_URL = 'https://www.sfr.fr/mon-espace-client/'
const HOMEPAGE_URL =
  'https://www.sfr.fr/mon-espace-client/#sfrclicid=EC_mire_Me-Connecter'
const PERSONAL_INFOS_URL =
  'https://espace-client.sfr.fr/infospersonnelles/contrat/informations/'
const LOGOUT_SELECTOR = 'a[href*="openid-connect/logout'
const BILLS_URL_PATH =
  '/facture-mobile/consultation#sfrintid=EC_telecom_mob-abo_mob-factpaiement'
class SfrContentScript extends ContentScript {
  // ////////
  // PILOT //
  // ////////
  async ensureAuthenticated() {
    this.log('info', '🤖 ensureAuthenticated starts')
    // we always force logout to avoid conflicts with red accounts
    await this.ensureNotAuthenticated()
    await this.waitForUserAuthentication()
  }

  async waitForCurrentContract(contract) {
    await waitFor(
      async () => {
        const el = document.querySelector(`li[id='${contract.id}']`)
        if (el) {
          el.click()
          return false
        } else {
          const currentContract = await this.getCurrentContract()
          if (!currentContract) {
            return false
          }
          const result = currentContract.text === contract.text
          return result
        }
      },
      {
        interval: 1000,
        timeout: {
          milliseconds: 10000,
          message: new TimeoutError(
            'waitForCurrentContract ' + contract.text + ' timed out after 10sec'
          )
        }
      }
    )
    return true
  }

  async ensureNotAuthenticated() {
    this.log('info', '🤖 ensureNotAuthenticated starts')
    await this.goto(CLIENT_SPACE_URL)
    await Promise.race([
      this.waitForElementInWorker('#username'), // SFR Login form
      this.waitForElementInWorker(LOGOUT_SELECTOR) // SFR connected OR RED connected
    ])
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
    await this.waitForElementInWorker(`a[href="${PERSONAL_INFOS_URL}"]`)
    await this.clickAndWait(`a[href="${PERSONAL_INFOS_URL}"]`, '#emailContact')
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
      await this.saveCredentials(this.store.userCredentials)
    }
    await this.saveIdentity(this.store.userIdentity)
    await this.goto(CLIENT_SPACE_URL)
    await this.waitForElementInWorker(
      `a[href='https://espace-client.sfr.fr/gestion-ligne/lignes/ajouter']`
    )
    const contracts = await this.runInWorker('getContracts')
    for (const contract of contracts) {
      const contractName = contract.text
      await this.goto(CLIENT_SPACE_URL)
      await this.waitForElementInWorker(
        `a[href='https://espace-client.sfr.fr/gestion-ligne/lignes/ajouter']`
      )
      // first contract is the current one
      await this.goto('https://www.sfr.fr/routage/info-conso')
      await this.waitForElementInWorker('.sr-tabs')
      if (contract.id !== 'current') {
        await this.runInWorkerUntilTrue({
          method: 'waitForCurrentContract',
          args: [contract]
        })
      }
      await this.fetchCurrentContractBills(contractName, context)
    }
  }

  async fetchCurrentContractBills(contractName, context) {
    this.log('info', '🤖 Fetching current contract: ' + contractName)
    await this.goto(BASE_CLIENT_URL + BILLS_URL_PATH)
    await this.waitForElementInWorker(
      'button[onclick="plusFacture(); return false;"]'
    )
    await this.runInWorker('getMoreBills')
    await this.runInWorker('getBills')
    await this.saveBills(this.store.allBills, {
      context,
      subPath: contractName,
      fileIdAttributes: ['filename'],
      contentType: 'application/pdf',
      qualificationLabel: 'phone_invoice'
    })
  }

  async authWithCredentials() {
    this.log('info', 'authWithCredentials starts')
    await this.goto(CLIENT_SPACE_URL)
    await this.waitForElementInWorker(`${LOGOUT_SELECTOR}`)
    const reloginPage = await this.runInWorker('getReloginPage')
    if (reloginPage) {
      this.log('debug', 'Login expired, new authentication is needed')
      await this.waitForUserAuthentication()
      return true
    }
    return true
  }

  async authWithoutCredentials() {
    this.log('info', 'authWithoutCredentials starts')
    await this.goto(CLIENT_SPACE_URL)
    await this.waitForElementInWorker('#username')
    await this.waitForUserAuthentication()
    return true
  }

  // ////////
  // WORKER//
  // ////////

  async checkAuthenticated() {
    const loginField = document.querySelector('#username')
    const passwordField = document.querySelector('#password')
    if (loginField && passwordField) {
      const userCredentials = await this.findAndSendCredentials.bind(this)(
        loginField,
        passwordField
      )
      this.log('debug', 'Sendin userCredentials to Pilot')
      this.sendToPilot({
        userCredentials
      })
    }
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

  async findAndSendCredentials(login, password) {
    this.log('debug', 'findAndSendCredentials starts')
    let userLogin = login.value
    let userPassword = password.value
    const userCredentials = {
      login: userLogin,
      password: userPassword
    }
    return userCredentials
  }

  async getUserMail() {
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
    const mobilePhoneNumber = document.querySelector(
      '#telephoneContactMobile'
    ).innerHTML
    let homePhoneNumber = null
    if (document.querySelector('#telephoneContactFixe')) {
      homePhoneNumber = document.querySelector(
        '#telephoneContactFixe'
      ).innerHTML
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
    const contracts = Array.from(
      document
        .querySelector(
          `a[href='https://espace-client.sfr.fr/gestion-ligne/lignes/ajouter']`
        )
        .parentNode.parentNode.querySelectorAll('li')
    )
      .filter(el => !el.getAttribute('class'))
      .map(el => ({
        id: el.getAttribute('id') || 'current',
        text: el.innerText.trim()
      }))
    return contracts
  }

  async getCurrentContract() {
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
    const moreBillsSelector = 'button[onclick="plusFacture(); return false;"]'
    while (document.querySelector(`${moreBillsSelector}`) !== null) {
      this.log('debug', 'moreBillsButton detected, clicking')
      const moreBillsButton = document.querySelector(`${moreBillsSelector}`)
      moreBillsButton.click()
      // Here, we need to wait for the older bills to load on the page
      await sleep(3)
    }
    this.log('debug', 'No more moreBills button')
  }

  async getBills() {
    const lastBill = await this.findLastBill()
    this.log('debug', 'Last bill returned, getting old ones')
    const oldBills = await this.findOldBills()
    const allBills = lastBill.concat(oldBills)
    this.log('debug', 'Old bills returned, sending to Pilot')
    await this.sendToPilot({
      allBills
    })
    this.log('debug', 'getBills done')
  }

  async findLastBill() {
    this.log('debug', 'findLastBill starts')
    let lastBill = []
    const lastBillElement = document.querySelector(
      'div[class="sr-inline sr-xs-block "]'
    )
    const rawAmount = lastBillElement
      .querySelectorAll('div')[0]
      .querySelector('span').innerHTML
    const fullAmount = rawAmount
      .replace(/&nbsp;/g, '')
      .replace(/ /g, '')
      .replace(/\n/g, '')
    const amount = parseFloat(fullAmount.replace('€', ''))
    const currency = fullAmount.replace(/[0-9]*/g, '')
    const rawDate = lastBillElement
      .querySelectorAll('div')[1]
      .querySelectorAll('span')[1].innerHTML
    const dateArray = rawDate.split('/')
    const day = dateArray[0]
    const month = dateArray[1]
    const year = dateArray[2]
    const date = `${day}-${month}-${year}`
    const rawPaymentDate = lastBillElement
      .querySelectorAll('div')[1]
      .querySelectorAll('span')[0].innerHTML
    const paymentArray = rawPaymentDate.split('/')
    const paymentDay = paymentArray[0]
    const paymentMonth = paymentArray[1]
    const paymentYear = paymentArray[2]
    const filepath = lastBillElement
      .querySelectorAll('div')[3]
      .querySelector('a')
      .getAttribute('href')
    const fileurl = `${BASE_CLIENT_URL}${filepath}`
    const computedLastBill = {
      amount,
      currency: currency === '€' ? 'EUR' : currency,
      date: new Date(`${month}/${day}/${year}`),
      paymentDate: new Date(`${paymentMonth}/${paymentDay}/${paymentYear}`),
      filename: await getFileName(rawDate, amount, currency),
      vendor: 'sfr',
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
    if (lastBillElement.children[2].querySelectorAll('a')[1] !== undefined) {
      const detailedFilepath = lastBillElement.children[2]
        .querySelectorAll('a')[1]
        .getAttribute('href')
      const detailed = detailedFilepath.match('detail') ? true : false
      const detailedBill = {
        ...computedLastBill
      }
      detailedBill.filename = await getFileName(
        date,
        amount,
        currency,
        detailed
      )
      const fileurl = `${BASE_CLIENT_URL}${detailedFilepath}`
      const response = await ky.get(fileurl).blob()
      const dataUri = await blobToBase64(response)
      detailedBill.dataUri = dataUri
      lastBill.push(detailedBill)
    }
    // As it's impossible to have the pilot on the same domain as the worker
    // to match domain's specific cookie for the download to be done by saveFiles
    // we need to fetch the stream then pass it to the pilot
    const response = await ky.get(fileurl).blob()
    const dataUri = await blobToBase64(response)
    computedLastBill.dataUri = dataUri
    lastBill.push(computedLastBill)
    return lastBill
  }

  async findOldBills() {
    this.log('debug', 'findOldBills starts')
    let oldBills = []
    const allBillsElements = document
      .querySelector('#blocAjax')
      .querySelectorAll('.sr-container-content-line')
    let counter = 0
    for (const oneBill of allBillsElements) {
      this.log(
        'debug',
        `fetching bill ${counter++}/${allBillsElements.length}...`
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
      const date = `${day}-${month}-${year}`
      const rawPaymentDate = oneBill.children[1].innerHTML
        .replace(/\n/g, '')
        .replace(/ /g, '')
        .match(/([0-9]{2}[a-zûé]{3,4}.?-)/g)
      const filepath = oneBill.children[4]
        .querySelector('a')
        .getAttribute('href')
      const fileurl = `${BASE_CLIENT_URL}${filepath}`

      let computedBill = {
        amount,
        currency: currency === '€' ? 'EUR' : currency,
        date: new Date(`${month}/${day}/${year}`),
        filename: await getFileName(date, amount, currency),
        vendor: 'sfr',
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
      if (oneBill.children[4].querySelectorAll('a')[1] !== undefined) {
        const detailedFilepath = oneBill.children[4]
          .querySelectorAll('a')[1]
          .getAttribute('href')
        const detailed = detailedFilepath.match('detail') ? true : false
        const detailedBill = {
          ...computedBill
        }
        detailedBill.filename = await getFileName(
          date,
          amount,
          currency,
          detailed
        )
        const fileurl = `${BASE_CLIENT_URL}${detailedFilepath}`
        const response = await ky.get(fileurl).blob()
        const dataUri = await blobToBase64(response)
        detailedBill.dataUri = dataUri
        oldBills.push(detailedBill)
      }
      const response = await ky.get(fileurl).blob()
      const dataUri = await blobToBase64(response)
      computedBill.dataUri = dataUri
      oldBills.push(computedBill)
    }
    this.log('debug', 'Old bills fetched')
    return oldBills
  }

  async getReloginPage() {
    if (document.querySelector('#password')) {
      return true
    }
    return false
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
      'waitForCurrentContract'
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
  return `${date.replace(/\//g, '-')}_sfr_${amount}${currency}${
    detailed ? '_detailed' : ''
  }.pdf`
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
