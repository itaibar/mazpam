import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const JSON_PATH = path.join(__dirname, 'mazpam.json')

let pool = null
const usePostgres = !!process.env.DATABASE_URL

if (usePostgres) {
  const pg = await import('pg')
  pool = new pg.default.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  })
}

function loadJSON() {
  if (fs.existsSync(JSON_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'))
    } catch (e) { /* ignore */ }
  }
  return { tickets: [], people: ['איתי בר', 'אורי כוחיי', 'ליאור עגמי'] }
}

function saveJSON(data) {
  fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2))
}

const db = {
  async init() {
    if (usePostgres) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS tickets (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          department TEXT NOT NULL,
          environment TEXT NOT NULL,
          equipment_type TEXT NOT NULL,
          fault_type TEXT DEFAULT '',
          phone TEXT DEFAULT '',
          subject TEXT NOT NULL,
          description TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'פתוח',
          tech_on_call TEXT DEFAULT '',
          assignee TEXT DEFAULT '',
          notes TEXT DEFAULT '[]',
          close_reason TEXT DEFAULT '',
          closed_at TEXT DEFAULT '',
          branch TEXT DEFAULT 'main',
          escalated_to TEXT DEFAULT '',
          escalation_status TEXT DEFAULT '',
          messages TEXT DEFAULT '[]',
          escalation_answers TEXT DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS people (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          branch TEXT DEFAULT 'main',
          UNIQUE(name, branch)
        )
      `)
      // Add branch column if missing
      try { await pool.query("ALTER TABLE people ADD COLUMN branch TEXT DEFAULT 'main'") } catch(e) {}
      // Drop old unique constraint and add new one
      try { await pool.query("ALTER TABLE people DROP CONSTRAINT IF EXISTS people_name_key") } catch(e) {}
      try { await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS people_name_branch_idx ON people(name, branch)") } catch(e) {}

      const { rows } = await pool.query('SELECT COUNT(*) as count FROM people')
      if (parseInt(rows[0].count) === 0) {
        await pool.query("INSERT INTO people (name, branch) VALUES ('איתי בר', 'main'), ('אורי כוחיי', 'main'), ('ליאור עגמי', 'main') ON CONFLICT DO NOTHING")
      }
      // Add missing columns
      try { await pool.query("ALTER TABLE tickets ADD COLUMN fault_type TEXT DEFAULT ''") } catch(e) {}
      try { await pool.query("ALTER TABLE tickets ADD COLUMN close_reason TEXT DEFAULT ''") } catch(e) {}
      try { await pool.query("ALTER TABLE tickets ADD COLUMN closed_at TEXT DEFAULT ''") } catch(e) {}
      try { await pool.query("ALTER TABLE tickets ADD COLUMN branch TEXT DEFAULT 'main'") } catch(e) {}
      try { await pool.query("ALTER TABLE tickets ADD COLUMN escalated_to TEXT DEFAULT ''") } catch(e) {}
      try { await pool.query("ALTER TABLE tickets ADD COLUMN escalation_status TEXT DEFAULT ''") } catch(e) {}
      try { await pool.query("ALTER TABLE tickets ADD COLUMN messages TEXT DEFAULT '[]'") } catch(e) {}
      try { await pool.query("ALTER TABLE tickets ADD COLUMN escalation_answers TEXT DEFAULT ''") } catch(e) {}

      // Migrate UUIDs
      const { rows: uuidRows } = await pool.query("SELECT id FROM tickets WHERE id ~ '[a-f]' ORDER BY created_at ASC")
      if (uuidRows.length > 0) {
        const { rows: maxRows } = await pool.query("SELECT id FROM tickets WHERE id NOT LIKE '%-%' AND id ~ '^[0-9]+$' ORDER BY CAST(id AS INTEGER) DESC LIMIT 1")
        let nextNum = maxRows.length > 0 ? parseInt(maxRows[0].id) + 1 : 1
        for (const row of uuidRows) {
          const newId = String(nextNum).padStart(5, '0')
          await pool.query('UPDATE tickets SET id = $1 WHERE id = $2', [newId, row.id])
          nextNum++
        }
        console.log(`✅ Migrated ${uuidRows.length} ticket IDs`)
      }
      console.log('✅ Database initialized (PostgreSQL)')
    } else {
      const data = loadJSON()
      if (!data.tickets) data.tickets = []
      if (!data.people) data.people = ['איתי בר', 'אורי כוחיי', 'ליאור עגמי']
      // Add branch to existing tickets
      let changed = false
      data.tickets.forEach(t => {
        if (!t.branch) { t.branch = 'main'; changed = true }
        if (t.escalated_to === undefined) { t.escalated_to = ''; changed = true }
      })
      if (changed) saveJSON(data)
      console.log('✅ Database initialized (JSON file)')
    }
  },

  async generateId(branch) {
    const prefix = branch === 'main' ? '' : branch.toUpperCase()
    if (usePostgres) {
      let rows
      if (prefix) {
        const result = await pool.query(
          `SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 2) AS INTEGER)), 0) as max_id FROM tickets WHERE id LIKE $1`,
          [prefix + '%']
        )
        rows = result.rows
      } else {
        const result = await pool.query(
          `SELECT COALESCE(MAX(CAST(id AS INTEGER)), 0) as max_id FROM tickets WHERE id ~ '^[0-9]+$'`
        )
        rows = result.rows
      }
      return prefix + String(parseInt(rows[0].max_id) + 1).padStart(5, '0')
    } else {
      const data = loadJSON()
      const branchTickets = data.tickets.filter(t => (t.branch || 'main') === (branch === 'main' ? 'main' : branch))
      const maxId = branchTickets.reduce((max, t) => {
        const num = parseInt(t.id.replace(/[^0-9]/g, '')) || 0
        return Math.max(max, num)
      }, 0)
      return prefix + String(maxId + 1).padStart(5, '0')
    }
  },

  async getAllTickets(branch) {
    if (usePostgres) {
      if (branch === 'main') {
        // Main sees own tickets + escalated tickets (as pointers)
        const { rows } = await pool.query("SELECT * FROM tickets WHERE branch = 'main' OR escalated_to = 'main' ORDER BY created_at DESC")
        return rows.map(rowToTicket)
      } else {
        const { rows } = await pool.query('SELECT * FROM tickets WHERE branch = $1 ORDER BY created_at DESC', [branch])
        return rows.map(rowToTicket)
      }
    } else {
      const data = loadJSON()
      let tickets
      if (branch === 'main') {
        tickets = data.tickets.filter(t => (t.branch || 'main') === 'main' || t.escalated_to === 'main')
      } else {
        tickets = data.tickets.filter(t => t.branch === branch)
      }
      return tickets.map(jsonToTicket)
    }
  },

  async getTicket(id) {
    if (usePostgres) {
      const { rows } = await pool.query('SELECT * FROM tickets WHERE id = $1', [id])
      return rows.length > 0 ? rowToTicket(rows[0]) : null
    } else {
      const t = loadJSON().tickets.find(t => t.id === id)
      if (!t) return null
      return jsonToTicket(t)
    }
  },

  async createTicket(ticket) {
    if (usePostgres) {
      await pool.query(
        `INSERT INTO tickets (id, name, department, environment, equipment_type, fault_type, phone, subject, description, status, tech_on_call, assignee, notes, close_reason, closed_at, branch, escalated_to, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [ticket.id, ticket.name, ticket.department, ticket.environment, ticket.equipmentType, ticket.faultType, ticket.phone, ticket.subject, ticket.description, ticket.status, ticket.techOnCall, ticket.assignee, JSON.stringify(ticket.notes), '', '', ticket.branch || 'main', '', ticket.createdAt, ticket.updatedAt]
      )
    } else {
      const data = loadJSON()
      data.tickets.push({
        ...ticket,
        notes: JSON.stringify(ticket.notes),
        branch: ticket.branch || 'main',
        escalated_to: ''
      })
      saveJSON(data)
    }
  },

  async updateTicket(id, updates) {
    if (usePostgres) {
      await pool.query(
        'UPDATE tickets SET status=$1, tech_on_call=$2, assignee=$3, notes=$4, close_reason=$5, closed_at=$6, escalated_to=$7, escalation_status=$8, messages=$9, escalation_answers=$10, updated_at=$11 WHERE id=$12',
        [updates.status, updates.techOnCall, updates.assignee, JSON.stringify(updates.notes), updates.closeReason || '', updates.closedAt || '', updates.escalatedTo || '', updates.escalationStatus || '', JSON.stringify(updates.messages || []), updates.escalationAnswers || '', updates.updatedAt, id]
      )
    } else {
      const data = loadJSON()
      const index = data.tickets.findIndex(t => t.id === id)
      if (index !== -1) {
        data.tickets[index].status = updates.status
        data.tickets[index].techOnCall = updates.techOnCall
        data.tickets[index].assignee = updates.assignee
        data.tickets[index].notes = JSON.stringify(updates.notes)
        data.tickets[index].closeReason = updates.closeReason || ''
        data.tickets[index].closedAt = updates.closedAt || ''
        data.tickets[index].escalated_to = updates.escalatedTo || ''
        data.tickets[index].escalation_status = updates.escalationStatus || ''
        data.tickets[index].messages = JSON.stringify(updates.messages || [])
        data.tickets[index].escalation_answers = updates.escalationAnswers || ''
        data.tickets[index].updatedAt = updates.updatedAt
        saveJSON(data)
      }
    }
  },

  async deleteTicket(id) {
    if (usePostgres) {
      await pool.query('DELETE FROM tickets WHERE id = $1', [id])
    } else {
      const data = loadJSON()
      data.tickets = data.tickets.filter(t => t.id !== id)
      saveJSON(data)
    }
  },

  async getPeople(branch = 'main') {
    if (usePostgres) {
      const { rows } = await pool.query('SELECT name FROM people WHERE branch = $1 ORDER BY id', [branch])
      return rows.map(r => r.name)
    } else {
      const data = loadJSON()
      if (!data.peopleByBranch) return data.people || []
      return data.peopleByBranch[branch] || []
    }
  },

  async addPerson(name, branch = 'main') {
    if (usePostgres) {
      await pool.query('INSERT INTO people (name, branch) VALUES ($1, $2)', [name, branch])
    } else {
      const data = loadJSON()
      if (!data.peopleByBranch) {
        data.peopleByBranch = { main: data.people || [] }
        delete data.people
      }
      if (!data.peopleByBranch[branch]) data.peopleByBranch[branch] = []
      if (data.peopleByBranch[branch].includes(name)) throw new Error('exists')
      data.peopleByBranch[branch].push(name)
      saveJSON(data)
    }
  },

  async removePerson(name, branch = 'main') {
    if (usePostgres) {
      const result = await pool.query('DELETE FROM people WHERE name = $1 AND branch = $2', [name, branch])
      return result.rowCount > 0
    } else {
      const data = loadJSON()
      if (!data.peopleByBranch) return false
      const list = data.peopleByBranch[branch]
      if (!list) return false
      const index = list.indexOf(name)
      if (index === -1) return false
      list.splice(index, 1)
      saveJSON(data)
      return true
    }
  }
}

function jsonToTicket(t) {
  return {
    id: t.id,
    name: t.name,
    department: t.department,
    environment: t.environment,
    equipmentType: t.equipmentType || t.equipment_type || '',
    faultType: t.faultType || t.fault_type || '',
    closeReason: t.closeReason || t.close_reason || '',
    closedAt: t.closedAt || t.closed_at || '',
    branch: t.branch || 'main',
    escalatedTo: t.escalatedTo || t.escalated_to || '',
    escalationStatus: t.escalationStatus || t.escalation_status || '',
    messages: typeof (t.messages || t.messages) === 'string' ? JSON.parse(t.messages || '[]') : (t.messages || []),
    escalationAnswers: t.escalationAnswers || t.escalation_answers || '',
    phone: t.phone || '',
    subject: t.subject,
    description: t.description,
    status: t.status,
    techOnCall: t.techOnCall || t.tech_on_call || '',
    assignee: t.assignee || '',
    notes: typeof t.notes === 'string' ? JSON.parse(t.notes) : (t.notes || []),
    createdAt: t.createdAt || t.created_at,
    updatedAt: t.updatedAt || t.updated_at
  }
}

function rowToTicket(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    department: row.department,
    environment: row.environment,
    equipmentType: row.equipment_type,
    faultType: row.fault_type || '',
    closeReason: row.close_reason || '',
    closedAt: row.closed_at || '',
    branch: row.branch || 'main',
    escalatedTo: row.escalated_to || '',
    escalationStatus: row.escalation_status || '',
    messages: row.messages ? JSON.parse(row.messages) : [],
    escalationAnswers: row.escalation_answers || '',
    phone: row.phone || '',
    subject: row.subject,
    description: row.description,
    status: row.status,
    techOnCall: row.tech_on_call || '',
    assignee: row.assignee || '',
    notes: row.notes ? JSON.parse(row.notes) : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export default db
