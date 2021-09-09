import Backchannel, { EVENTS } from 'backchannel';
import { Buffer } from 'buffer';
import randomBytes from 'randombytes';

let feedback = document.querySelector('#feedback')
let contactsDiv = document.querySelector('#contacts')
let codeInput = document.querySelector('#my-code')


const DBNAME = 'bc-example'

// user-defined settings, we provide a default.
const SETTINGS = {
	relay: 'ws://localhost:3001'
}
let backchannel = new Backchannel(DBNAME, SETTINGS)
backchannel.once(EVENTS.OPEN, () => {
	setTimeout(()=> {
		getCode()
	}, 60 * 1000)
	getCode()
	let contacts = backchannel.listContacts()
	contacts.forEach(addToContactDOM)
})

function addToContactDOM (contact) {
	let el = document.createElement('div')
	el.innerHTML = `${contact.id} : ${contact.moniker || 'NO NAME	'}`
	contactsDiv.appendChild(el)
}

async function getCode() {
	let random = randomBytes(3)
	let code = parseInt(Buffer.from(random).toString('hex'), 16)
	codeInput.innerHTML = code

	try { 
		let [ mailbox, password ]  = splitCode(code)
		console.log('joining', mailbox, password)
		let key = await backchannel.accept(mailbox, password)
		let id = await backchannel.addContact(key)
		let contact = await backchannel.contacts.find(c => c.id === id)
		addToContactDOM(contact)
	} catch (err) {
		feedback.innerHTML = 'ERROR: ' + err.message
	}
	getCode()
	return 
}

function splitCode (code) {
	code = code.toString()
	let mailbox = 'myapp+' + code.slice(0, 2)
	let password = code.slice(2)
	return [mailbox, password]
}


document.querySelector('#redeem-code').onsubmit = async (e) => {
	e.preventDefault()
	let name = e.target[0]
	let input = e.target[1]
	let code = input.value

	try { 
		let [ mailbox, password ]  = splitCode(code)
		let key = await backchannel.accept(mailbox, password)
		let id = await backchannel.addContact(key)
		let contact = await backchannel.editMoniker(id, name.value)
		addToContactDOM(contact)
	} catch (err) {
		feedback.innerHTML = 'ERROR: ' + err.message
	}

	input.value = ''
	name.value = ''

}