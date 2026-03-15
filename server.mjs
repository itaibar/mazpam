import http from 'http'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import pg from 'pg'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3001

// Admin credentials (change these)
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123'

// Active admin tokens
const adminTokens = new Set()

// PostgreSQL connection
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
})

// Initialize database tables
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      department TEXT NOT NULL,
      environment TEXT NOT NULL,
      equipment_type TEXT NOT NULL,
      phone TEXT DEFAULT '',
      subject TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'פתוח',
      tech_on_call TEXT DEFAULT '',
      assignee TEXT DEFAULT '',
      notes TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS people (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    )
  `)

  // Seed default people if table is empty
  const { rows } = await pool.query('SELECT COUNT(*) as count FROM people')
  if (parseInt(rows[0].count) === 0) {
    await pool.query("INSERT INTO people (name) VALUES ('איתי בר'), ('אורי כוחיי'), ('ליאור עגמי') ON CONFLICT DO NOTHING")
  }

  // Migrate old UUID IDs to sequential numbers
  const { rows: uuidRows } = await pool.query("SELECT id FROM tickets WHERE LENGTH(id) > 5 ORDER BY created_at ASC")
  if (uuidRows.length > 0) {
    const { rows: maxRows } = await pool.query("SELECT id FROM tickets WHERE LENGTH(id) <= 5 ORDER BY id DESC LIMIT 1")
    let nextNum = maxRows.length > 0 ? parseInt(maxRows[0].id) + 1 : 1
    for (const row of uuidRows) {
      const newId = String(nextNum).padStart(5, '0')
      await pool.query('UPDATE tickets SET id = $1 WHERE id = $2', [newId, row.id])
      nextNum++
    }
    console.log(`✅ Migrated ${uuidRows.length} ticket IDs to sequential numbers`)
  }

  console.log('✅ Database initialized')
}

async function generateId() {
  const { rows } = await pool.query('SELECT COUNT(*) as count FROM tickets')
  const next = parseInt(rows[0].count) + 1
  return String(next).padStart(5, '0')
}

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

function rowToTicket(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    department: row.department,
    environment: row.environment,
    equipmentType: row.equipment_type,
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

function calculateSLA(createdAt) {
  const created = new Date(createdAt)
  const slaHours = 48
  const dueDate = new Date(created.getTime() + slaHours * 60 * 60 * 1000)
  const now = new Date()
  return {
    dueDate: dueDate.toISOString(),
    hoursRemaining: (dueDate - now) / (60 * 60 * 1000),
    isOverdue: now > dueDate,
    status: now > dueDate ? 'חרוג' : (dueDate - now) < (2 * 60 * 60 * 1000) ? 'קרוב' : 'בזמן'
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

function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
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

  try {
    // Serve frontend
    if (req.url === '/' || req.url === '') {
      serveFile(res, path.join(__dirname, 'index.html'), 'text/html')
      return
    }

    // Login
    if (req.url === '/api/login' && req.method === 'POST') {
      const body = await readBody(req)
      const { username, password } = JSON.parse(body)
      if (username === ADMIN_USER && password === ADMIN_PASS) {
        const token = generateToken()
        adminTokens.add(token)
        jsonResponse(res, 200, { token })
      } else {
        jsonResponse(res, 401, { error: 'שם משתמש או סיסמה שגויים' })
      }
      return
    }

    // Logout
    if (req.url === '/api/logout' && req.method === 'POST') {
      const auth = req.headers['authorization']
      if (auth && auth.startsWith('Bearer ')) {
        adminTokens.delete(auth.slice(7))
      }
      jsonResponse(res, 200, { ok: true })
      return
    }

    // Config (public)
    if (req.url === '/api/config' && req.method === 'GET') {
      const { rows } = await pool.query('SELECT name FROM people ORDER BY id')
      const people = rows.map(r => r.name)
      jsonResponse(res, 200, { ...ticketConfigs, people })
      return
    }

    // Add person (admin only)
    if (req.url === '/api/people' && req.method === 'POST') {
      if (!isAdmin(req)) { jsonResponse(res, 401, { error: 'Unauthorized' }); return }
      const body = await readBody(req)
      const { name } = JSON.parse(body)
      if (!name || !name.trim()) { jsonResponse(res, 400, { error: 'Missing name' }); return }
      try {
        await pool.query('INSERT INTO people (name) VALUES ($1)', [name.trim()])
      } catch (e) {
        jsonResponse(res, 400, { error: 'Person already exists' }); return
      }
      const { rows } = await pool.query('SELECT name FROM people ORDER BY id')
      jsonResponse(res, 201, { people: rows.map(r => r.name) })
      return
    }

    // Remove person (admin only)
    if (req.url.startsWith('/api/people/') && req.method === 'DELETE') {
      if (!isAdmin(req)) { jsonResponse(res, 401, { error: 'Unauthorized' }); return }
      const name = decodeURIComponent(req.url.split('/api/people/')[1])
      const result = await pool.query('DELETE FROM people WHERE name = $1', [name])
      if (result.rowCount === 0) { jsonResponse(res, 404, { error: 'Person not found' }); return }
      const { rows } = await pool.query('SELECT name FROM people ORDER BY id')
      jsonResponse(res, 200, { people: rows.map(r => r.name) })
      return
    }

    // Create ticket (public)
    if (req.url === '/api/tickets' && req.method === 'POST') {
      const body = await readBody(req)
      const data = JSON.parse(body)
      const { name, department, environment, equipmentType, phone, subject, description } = data

      if (!name || !department || !environment || !equipmentType || !subject || !description) {
        jsonResponse(res, 400, { error: 'Missing required fields' }); return
      }

      const id = await generateId()
      const now = new Date().toISOString()

      await pool.query(
        `INSERT INTO tickets (id, name, department, environment, equipment_type, phone, subject, description, status, tech_on_call, assignee, notes, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [id, name, department, environment, equipmentType, phone || '', subject, description, 'פתוח', '', '', '[]', now, now]
      )

      const ticket = { id, name, department, environment, equipmentType, phone: phone || '', subject, description, status: 'פתוח', techOnCall: '', assignee: '', createdAt: now, updatedAt: now, notes: [] }
      jsonResponse(res, 201, { ...ticket, sla: calculateSLA(now) })
      return
    }

    // ---- Admin-only routes below ----

    // List tickets (admin only)
    if (req.url === '/api/tickets' && req.method === 'GET') {
      if (!isAdmin(req)) { jsonResponse(res, 401, { error: 'Unauthorized' }); return }
      const { rows } = await pool.query('SELECT * FROM tickets ORDER BY created_at DESC')
      const tickets = rows.map(row => {
        const ticket = rowToTicket(row)
        return { ...ticket, sla: calculateSLA(ticket.createdAt) }
      })
      jsonResponse(res, 200, tickets)
      return
    }

    // Get single ticket (admin only)
    if (req.url.match(/^\/api\/tickets\/[0-9]+$/) && req.method === 'GET') {
      if (!isAdmin(req)) { jsonResponse(res, 401, { error: 'Unauthorized' }); return }
      const id = req.url.split('/')[3]
      const { rows } = await pool.query('SELECT * FROM tickets WHERE id = $1', [id])
      if (rows.length === 0) { jsonResponse(res, 404, { error: 'Ticket not found' }); return }
      const ticket = rowToTicket(rows[0])
      jsonResponse(res, 200, { ...ticket, sla: calculateSLA(ticket.createdAt) })
      return
    }

    // Update ticket (admin only)
    if (req.url.match(/^\/api\/tickets\/[0-9]+$/) && req.method === 'PATCH') {
      if (!isAdmin(req)) { jsonResponse(res, 401, { error: 'Unauthorized' }); return }
      const id = req.url.split('/')[3]
      const { rows } = await pool.query('SELECT * FROM tickets WHERE id = $1', [id])
      if (rows.length === 0) { jsonResponse(res, 404, { error: 'Ticket not found' }); return }

      const body = await readBody(req)
      const data = JSON.parse(body)
      const ticket = rowToTicket(rows[0])

      if (data.status !== undefined) ticket.status = data.status
      if (data.techOnCall !== undefined) ticket.techOnCall = data.techOnCall
      if (data.assignee !== undefined) ticket.assignee = data.assignee
      if (data.notes !== undefined) ticket.notes = data.notes
      ticket.updatedAt = new Date().toISOString()

      await pool.query(
        'UPDATE tickets SET status=$1, tech_on_call=$2, assignee=$3, notes=$4, updated_at=$5 WHERE id=$6',
        [ticket.status, ticket.techOnCall, ticket.assignee, JSON.stringify(ticket.notes), ticket.updatedAt, id]
      )

      jsonResponse(res, 200, { ...ticket, sla: calculateSLA(ticket.createdAt) })
      return
    }

    // Delete ticket (admin only)
    if (req.url.match(/^\/api\/tickets\/[0-9]+$/) && req.method === 'DELETE') {
      if (!isAdmin(req)) { jsonResponse(res, 401, { error: 'Unauthorized' }); return }
      const id = req.url.split('/')[3]
      const { rows } = await pool.query('SELECT * FROM tickets WHERE id = $1', [id])
      if (rows.length === 0) { jsonResponse(res, 404, { error: 'Ticket not found' }); return }
      const ticket = rowToTicket(rows[0])
      await pool.query('DELETE FROM tickets WHERE id = $1', [id])
      jsonResponse(res, 200, ticket)
      return
    }

    // Static files
    const filePath = path.join(__dirname, req.url)
    const ext = path.extname(req.url)
    const contentTypes = {
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.html': 'text/html',
      '.svg': 'image/svg+xml',
      '.avif': 'image/avif',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.ico': 'image/x-icon'
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

  } catch (e) {
    console.error('Server error:', e)
    jsonResponse(res, 500, { error: 'Internal server error' })
  }
})

// Start
initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`)
    console.log('🔑 Admin login: admin / admin123')
  })
}).catch(err => {
  console.error('❌ Failed to initialize database:', err)
  process.exit(1)
})
