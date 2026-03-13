import http from 'http'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import Database from './sqlite-wrapper.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Admin credentials (change these)
const ADMIN_USER = 'admin'
const ADMIN_PASS = 'admin123'

// Active admin tokens
const adminTokens = new Set()

// Initialize SQLite database
const dbPath = path.join(__dirname, 'mazpam.db')
const db = new Database(dbPath)

// Create tickets table if it doesn't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    department TEXT NOT NULL,
    environment TEXT NOT NULL,
    equipmentType TEXT NOT NULL,
    phone TEXT,
    subject TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL,
    techOnCall TEXT,
    assignee TEXT,
    notes TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )
`)

function generateId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0,
      v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex')
}

function isAdmin(req) {
  const auth = req.headers['authorization']
  if (!auth || !auth.startsWith('Bearer ')) return false
  return adminTokens.has(auth.slice(7))
}

let ticketConfigs = {
  statuses: ['פתוח', 'בעבודה', 'בהמתנה', 'סגור'],
  departments: ['תא דיווח', 'תא מפקד', 'תא פקודות', 'תא תכנון', 'תקשוב', 'שולחן מרכזי', 'רפואה', 'מלכ״א', 'מודיעין', 'הלפדסק', 'אוכלוסיה'],
  slaHours: {
    'default': 48
  }
}

// Helper function to convert DB row to ticket object
function rowToTicket(row) {
  if (!row) return null
  return {
    ...row,
    notes: row.notes ? JSON.parse(row.notes) : []
  }
}

function calculateSLA(createdAt) {
  const created = new Date(createdAt)
  const slaHours = ticketConfigs.slaHours['default']
  const dueDate = new Date(created.getTime() + slaHours * 60 * 60 * 1000)
  const now = new Date()

  return {
    dueDate: dueDate.toISOString(),
    hoursRemaining: (dueDate - now) / (60 * 60 * 1000),
    isOverdue: now > dueDate,
    status: now > dueDate ? 'חרוג (Overdue)' : (dueDate - now) < (2 * 60 * 60 * 1000) ? 'קרוב (Close)' : 'בזמן (On Time)'
  }
}

function serveFile(res, filePath, contentType = 'text/html') {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
      return
    }
    let type = contentType
    if (filePath.endsWith('.js')) type = 'application/javascript'
    else if (filePath.endsWith('.css')) type = 'text/css'
    else if (filePath.endsWith('.json')) type = 'application/json'
    res.writeHead(200, { 'Content-Type': type })
    res.end(data)
  })
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => resolve(body))
  })
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }

  // Serve frontend
  if (req.url === '/' || req.url === '') {
    serveFile(res, path.join(__dirname, 'index.html'), 'text/html')
    return
  }

  // Login
  if (req.url === '/api/login' && req.method === 'POST') {
    const body = await readBody(req)
    try {
      const { username, password } = JSON.parse(body)
      if (username === ADMIN_USER && password === ADMIN_PASS) {
        const token = generateToken()
        adminTokens.add(token)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ token }))
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'שם משתמש או סיסמה שגויים' }))
      }
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid JSON' }))
    }
    return
  }

  // Logout
  if (req.url === '/api/logout' && req.method === 'POST') {
    const auth = req.headers['authorization']
    if (auth && auth.startsWith('Bearer ')) {
      adminTokens.delete(auth.slice(7))
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // Config (public)
  if (req.url === '/api/config' && req.method === 'GET') {
    const people = db.data.people || []
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ...ticketConfigs, people }))
    return
  }

  // Add person (admin only)
  if (req.url === '/api/people' && req.method === 'POST') {
    if (!isAdmin(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    const body = await readBody(req)
    try {
      const { name } = JSON.parse(body)
      if (!name || !name.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing name' }))
        return
      }
      if (!db.data.people) db.data.people = []
      if (db.data.people.includes(name.trim())) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Person already exists' }))
        return
      }
      db.data.people.push(name.trim())
      db.saveData()
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ people: db.data.people }))
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid JSON' }))
    }
    return
  }

  // Remove person (admin only)
  if (req.url.startsWith('/api/people/') && req.method === 'DELETE') {
    if (!isAdmin(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    const name = decodeURIComponent(req.url.split('/api/people/')[1])
    if (!db.data.people) db.data.people = []
    const index = db.data.people.indexOf(name)
    if (index === -1) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Person not found' }))
      return
    }
    db.data.people.splice(index, 1)
    db.saveData()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ people: db.data.people }))
    return
  }

  // Create ticket (public)
  if (req.url === '/api/tickets' && req.method === 'POST') {
    const body = await readBody(req)
    try {
      const data = JSON.parse(body)
      const { name, department, environment, equipmentType, phone, subject, description } = data

      if (!name || !department || !environment || !equipmentType || !subject || !description) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing required fields' }))
        return
      }

      const id = generateId()
      const now = new Date().toISOString()
      const status = 'פתוח'
      const notes = JSON.stringify([])

      const stmt = db.prepare(`
        INSERT INTO tickets (id, name, department, environment, equipmentType, phone, subject, description, status, techOnCall, assignee, notes, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      stmt.run(id, name, department, environment, equipmentType, phone || '', subject, description, status, '', '', notes, now, now)

      const ticket = {
        id,
        name,
        department,
        environment,
        equipmentType,
        phone: phone || '',
        subject,
        description,
        status,
        techOnCall: '',
        assignee: '',
        createdAt: now,
        updatedAt: now,
        notes: []
      }

      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ...ticket, sla: calculateSLA(ticket.createdAt) }))
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid JSON' }))
    }
    return
  }

  // ---- Admin-only routes below ----

  // List tickets (admin only)
  if (req.url === '/api/tickets' && req.method === 'GET') {
    if (!isAdmin(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    const stmt = db.prepare('SELECT * FROM tickets')
    const rows = stmt.all()
    const enhancedTickets = rows.map(row => {
      const ticket = rowToTicket(row)
      return {
        ...ticket,
        sla: calculateSLA(ticket.createdAt)
      }
    })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(enhancedTickets))
    return
  }

  // Get single ticket (admin only)
  if (req.url.match(/^\/api\/tickets\/[a-f0-9\-]+$/) && req.method === 'GET') {
    if (!isAdmin(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    const id = req.url.split('/')[3]
    const stmt = db.prepare('SELECT * FROM tickets WHERE id = ?')
    const row = stmt.get(id)
    if (!row) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Ticket not found' }))
      return
    }
    const ticket = rowToTicket(row)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ...ticket, sla: calculateSLA(ticket.createdAt) }))
    return
  }

  // Update ticket (admin only)
  if (req.url.match(/^\/api\/tickets\/[a-f0-9\-]+$/) && req.method === 'PATCH') {
    if (!isAdmin(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    const id = req.url.split('/')[3]
    const getStmt = db.prepare('SELECT * FROM tickets WHERE id = ?')
    const row = getStmt.get(id)
    if (!row) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Ticket not found' }))
      return
    }

    const body = await readBody(req)
    try {
      const data = JSON.parse(body)
      const ticket = rowToTicket(row)

      if (data.status !== undefined) ticket.status = data.status
      if (data.techOnCall !== undefined) ticket.techOnCall = data.techOnCall
      if (data.assignee !== undefined) ticket.assignee = data.assignee
      if (data.notes !== undefined) ticket.notes = data.notes
      ticket.updatedAt = new Date().toISOString()

      const updateStmt = db.prepare(`
        UPDATE tickets
        SET status = ?, techOnCall = ?, assignee = ?, notes = ?, updatedAt = ?
        WHERE id = ?
      `)
      updateStmt.run(ticket.status, ticket.techOnCall, ticket.assignee, JSON.stringify(ticket.notes), ticket.updatedAt, id)

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ...ticket, sla: calculateSLA(ticket.createdAt) }))
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid JSON' }))
    }
    return
  }

  // Delete ticket (admin only)
  if (req.url.match(/^\/api\/tickets\/[a-f0-9\-]+$/) && req.method === 'DELETE') {
    if (!isAdmin(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    const id = req.url.split('/')[3]
    const getStmt = db.prepare('SELECT * FROM tickets WHERE id = ?')
    const row = getStmt.get(id)
    if (!row) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Ticket not found' }))
      return
    }
    const ticket = rowToTicket(row)
    const deleteStmt = db.prepare('DELETE FROM tickets WHERE id = ?')
    deleteStmt.run(id)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(ticket))
    return
  }

  // Static files
  const filePath = path.join(__dirname, req.url)
  const ext = path.extname(req.url)
  const contentTypes = {
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.html': 'text/html'
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404)
      res.end('Not found')
      return
    }
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' })
    res.end(data)
  })
})

server.listen(3001, () => {
  console.log('✅ Server running on http://localhost:3001')
  console.log('📝 Open http://localhost:3001 in your browser')
  console.log('🔑 Admin login: admin / admin123')
})
