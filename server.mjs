import http from 'http'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import db from './db.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3001

const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123'

const adminTokens = new Set()

function generateToken() {
  return crypto.randomBytes(32).toString('hex')
}

function isAdmin(req) {
  const auth = req.headers['authorization']
  if (!auth || !auth.startsWith('Bearer ')) return false
  return adminTokens.has(auth.slice(7))
}

const ticketConfigs = {
  statuses: ['פתוח', 'בעבודה', 'בהמתנה', 'סגור'],
  departments: ['תא דיווח', 'תא מפקד', 'תא פקודות', 'תא תכנון', 'תקשוב', 'שולחן מרכזי', 'רפואה', 'מלכ״א', 'מודיעין', 'הלפדסק', 'אוכלוסיה'],
}

function calculateSLA(createdAt) {
  const created = new Date(createdAt)
  const dueDate = new Date(created.getTime() + 48 * 60 * 60 * 1000)
  const now = new Date()
  return {
    dueDate: dueDate.toISOString(),
    hoursRemaining: (dueDate - now) / (60 * 60 * 1000),
    isOverdue: now > dueDate,
    status: now > dueDate ? 'חרוג' : (dueDate - now) < (2 * 60 * 60 * 1000) ? 'קרוב' : 'בזמן'
  }
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return }
    const types = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.avif':'image/avif', '.ico':'image/x-icon' }
    res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'text/plain' })
    res.end(data)
  })
}

function readBody(req) {
  return new Promise(resolve => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => resolve(body))
  })
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return }

  try {
    if (req.url === '/' || req.url === '') {
      serveFile(res, path.join(__dirname, 'index.html')); return
    }

    // Login
    if (req.url === '/api/login' && req.method === 'POST') {
      const { username, password } = JSON.parse(await readBody(req))
      if (username === ADMIN_USER && password === ADMIN_PASS) {
        const token = generateToken()
        adminTokens.add(token)
        json(res, 200, { token })
      } else {
        json(res, 401, { error: 'שם משתמש או סיסמה שגויים' })
      }
      return
    }

    // Logout
    if (req.url === '/api/logout' && req.method === 'POST') {
      const auth = req.headers['authorization']
      if (auth?.startsWith('Bearer ')) adminTokens.delete(auth.slice(7))
      json(res, 200, { ok: true }); return
    }

    // Config
    if (req.url === '/api/config' && req.method === 'GET') {
      const people = await db.getPeople()
      json(res, 200, { ...ticketConfigs, people }); return
    }

    // Add person
    if (req.url === '/api/people' && req.method === 'POST') {
      if (!isAdmin(req)) { json(res, 401, { error: 'Unauthorized' }); return }
      const { name } = JSON.parse(await readBody(req))
      if (!name?.trim()) { json(res, 400, { error: 'Missing name' }); return }
      try {
        await db.addPerson(name.trim())
      } catch (e) { json(res, 400, { error: 'Person already exists' }); return }
      json(res, 201, { people: await db.getPeople() }); return
    }

    // Remove person
    if (req.url.startsWith('/api/people/') && req.method === 'DELETE') {
      if (!isAdmin(req)) { json(res, 401, { error: 'Unauthorized' }); return }
      const name = decodeURIComponent(req.url.split('/api/people/')[1])
      const removed = await db.removePerson(name)
      if (!removed) { json(res, 404, { error: 'Person not found' }); return }
      json(res, 200, { people: await db.getPeople() }); return
    }

    // Create ticket
    if (req.url === '/api/tickets' && req.method === 'POST') {
      const data = JSON.parse(await readBody(req))
      const { name, department, environment, equipmentType, faultType, phone, subject, description } = data
      if (!name || !department || !environment || !equipmentType || !subject || !description) {
        json(res, 400, { error: 'Missing required fields' }); return
      }
      const id = await db.generateId()
      const now = new Date().toISOString()
      const ticket = { id, name, department, environment, equipmentType, faultType: faultType || '', phone: phone || '', subject, description, status: 'פתוח', techOnCall: '', assignee: '', createdAt: now, updatedAt: now, notes: [] }
      await db.createTicket(ticket)
      json(res, 201, { ...ticket, sla: calculateSLA(now) }); return
    }

    // List tickets (admin)
    if (req.url === '/api/tickets' && req.method === 'GET') {
      if (!isAdmin(req)) { json(res, 401, { error: 'Unauthorized' }); return }
      const tickets = await db.getAllTickets()
      json(res, 200, tickets.map(t => ({ ...t, sla: calculateSLA(t.createdAt) }))); return
    }

    // Get ticket (admin)
    if (req.url.match(/^\/api\/tickets\/[0-9]+$/) && req.method === 'GET') {
      if (!isAdmin(req)) { json(res, 401, { error: 'Unauthorized' }); return }
      const ticket = await db.getTicket(req.url.split('/')[3])
      if (!ticket) { json(res, 404, { error: 'Ticket not found' }); return }
      json(res, 200, { ...ticket, sla: calculateSLA(ticket.createdAt) }); return
    }

    // Update ticket (admin)
    if (req.url.match(/^\/api\/tickets\/[0-9]+$/) && req.method === 'PATCH') {
      if (!isAdmin(req)) { json(res, 401, { error: 'Unauthorized' }); return }
      const id = req.url.split('/')[3]
      const ticket = await db.getTicket(id)
      if (!ticket) { json(res, 404, { error: 'Ticket not found' }); return }
      const data = JSON.parse(await readBody(req))
      if (data.status !== undefined) ticket.status = data.status
      if (data.techOnCall !== undefined) ticket.techOnCall = data.techOnCall
      if (data.assignee !== undefined) ticket.assignee = data.assignee
      if (data.notes !== undefined) ticket.notes = data.notes
      if (data.closeReason !== undefined) ticket.closeReason = data.closeReason
      if (data.closedAt !== undefined) ticket.closedAt = data.closedAt
      ticket.updatedAt = new Date().toISOString()
      await db.updateTicket(id, ticket)
      json(res, 200, { ...ticket, sla: calculateSLA(ticket.createdAt) }); return
    }

    // Delete ticket (admin)
    if (req.url.match(/^\/api\/tickets\/[0-9]+$/) && req.method === 'DELETE') {
      if (!isAdmin(req)) { json(res, 401, { error: 'Unauthorized' }); return }
      const id = req.url.split('/')[3]
      const ticket = await db.getTicket(id)
      if (!ticket) { json(res, 404, { error: 'Ticket not found' }); return }
      await db.deleteTicket(id)
      json(res, 200, ticket); return
    }

    // Static files
    serveFile(res, path.join(__dirname, req.url))

  } catch (e) {
    console.error('Server error:', e)
    json(res, 500, { error: 'Internal server error' })
  }
})

db.init().then(() => {
  server.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`)
    console.log('🔑 Admin login: admin / admin123')
  })
}).catch(err => {
  console.error('❌ Failed to initialize database:', err)
  process.exit(1)
})
