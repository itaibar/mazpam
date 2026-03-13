import fs from 'fs'
import path from 'path'

// Simple SQLite wrapper that uses JSON file storage
// This is a workaround for npm registry access issues
export default class Database {
  constructor(dbPath) {
    this.dbPath = dbPath
    this.dataPath = dbPath.replace('.db', '.json')
    this.data = {
      tickets: [],
      people: ['איתי בר', 'אורי כוחיי', 'ליאור עגמי']
    }

    // Load existing data if available
    if (fs.existsSync(this.dataPath)) {
      try {
        const content = fs.readFileSync(this.dataPath, 'utf-8')
        this.data = JSON.parse(content)
      } catch (e) {
        console.log('Creating new database file')
      }
    }

    this.saveData()
  }

  saveData() {
    fs.writeFileSync(this.dataPath, JSON.stringify(this.data, null, 2))
  }

  exec(sql) {
    // Handle CREATE TABLE IF NOT EXISTS
    if (sql.includes('CREATE TABLE IF NOT EXISTS tickets')) {
      if (!this.data.tickets) this.data.tickets = []
      if (!this.data.people) this.data.people = ['איתי בר', 'אורי כוחיי', 'ליאור עגמי']
      this.saveData()
    }
  }

  prepare(sql) {
    const self = this

    return {
      run: function(...params) {
        if (sql.includes('INSERT INTO tickets')) {
          const [id, name, department, environment, equipmentType, phone, subject, description, status, techOnCall, assignee, notes, createdAt, updatedAt] = params
          const ticket = {
            id, name, department, environment, equipmentType, phone, subject, description, status, techOnCall, assignee, notes, createdAt, updatedAt
          }
          self.data.tickets.push(ticket)
          self.saveData()
          return { changes: 1 }
        } else if (sql.includes('UPDATE tickets')) {
          const [status, techOnCall, assignee, notes, updatedAt, id] = params
          const index = self.data.tickets.findIndex(t => t.id === id)
          if (index !== -1) {
            self.data.tickets[index] = {
              ...self.data.tickets[index],
              status, techOnCall, assignee, notes, updatedAt
            }
            self.saveData()
            return { changes: 1 }
          }
          return { changes: 0 }
        } else if (sql.includes('DELETE FROM tickets')) {
          const [id] = params
          const index = self.data.tickets.findIndex(t => t.id === id)
          if (index !== -1) {
            self.data.tickets.splice(index, 1)
            self.saveData()
            return { changes: 1 }
          }
          return { changes: 0 }
        }
      },

      get: function(...params) {
        if (sql.includes('SELECT * FROM tickets WHERE id = ?')) {
          const [id] = params
          return self.data.tickets.find(t => t.id === id) || null
        }
      },

      all: function(...params) {
        if (sql.includes('SELECT * FROM tickets')) {
          return self.data.tickets
        }
        return []
      }
    }
  }
}
