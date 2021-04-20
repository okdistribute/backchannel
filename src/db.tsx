import Dexie from 'dexie'

export interface IContact {
  id?: number,
  moniker?: string,
  key: string
}

export class Database extends Dexie {
  contacts: Dexie.Table<IContact, number>

  constructor (dbname) {
    super(dbname)
    
    this.version(1).stores({
      contacts: 'id++,moniker,key'
    })

    this.contacts = this.table('contacts')
  }
}