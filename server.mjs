import http from 'http'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import db from './db.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3001

// Branch configuration
const BRANCHES = {
  main:    { name: 'מזפם', prefix: '',  admin: 'admin',   pass: process.env.ADMIN_PASS || 'admin123', subdomain: '' },
  A:       { name: 'עמקים', prefix: 'A', admin: 'admin_a', pass: process.env.ADMIN_PASS_A || 'admin123', subdomain: 'amakim' },
  M:       { name: 'מפרץ', prefix: 'M', admin: 'admin_m', pass: process.env.ADMIN_PASS_M || 'admin123', subdomain: 'mifratz' },
  H:       { name: 'חוף',   prefix: 'H', admin: 'admin_h', pass: process.env.ADMIN_PASS_H || 'admin123', subdomain: 'hof' },
  G:       { name: 'גדור', prefix: 'G', admin: 'admin_g', pass: process.env.ADMIN_PASS_G || 'admin123', subdomain: 'gdor' },
}

// Token -> branch key mapping
const adminTokens = new Map()

function generateToken() {
  return crypto.randomBytes(32).toString('hex')
}

function getAdminBranch(req) {
  const auth = req.headers['authorization']
  if (!auth || !auth.startsWith('Bearer ')) return null
  return adminTokens.get(auth.slice(7)) || null
}

function isAdmin(req) {
  return getAdminBranch(req) !== null
}

// Detect branch from Host header
function getBranchFromHost(req) {
  const host = (req.headers['host'] || '').split(':')[0].toLowerCase()
  // Check if it's a known subdomain
  for (const [key, branch] of Object.entries(BRANCHES)) {
    if (branch.subdomain && host.startsWith(branch.subdomain + '.')) {
      return key
    }
  }
  // Only allow exact main domain or localhost - no unknown subdomains
  const allowedHosts = ['takalot.online', 'mazpam-web.onrender.com', 'localhost', '127.0.0.1']
  if (allowedHosts.includes(host)) {
    return 'main'
  }
  return null // unknown subdomain
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

  const hostBranch = getBranchFromHost(req)

  if (hostBranch === null) {
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<h1>403 - גישה נדחתה</h1>')
    return
  }

  try {
    if (req.url === '/' || req.url === '') {
      serveFile(res, path.join(__dirname, 'index.html')); return
    }

    // Branch info (public) - tells the frontend which branch this is
    if (req.url === '/api/branch' && req.method === 'GET') {
      const b = BRANCHES[hostBranch]
      json(res, 200, { key: hostBranch, name: b.name, prefix: b.prefix, isMain: hostBranch === 'main' }); return
    }

    // Login - check credentials for this branch
    if (req.url === '/api/login' && req.method === 'POST') {
      const { username, password } = JSON.parse(await readBody(req))
      // Check all branches for matching credentials
      let matchedBranch = null
      for (const [key, branch] of Object.entries(BRANCHES)) {
        if (username === branch.admin && password === branch.pass) {
          matchedBranch = key
          break
        }
      }
      if (matchedBranch) {
        const token = generateToken()
        adminTokens.set(token, matchedBranch)
        json(res, 200, { token, branch: matchedBranch, branchName: BRANCHES[matchedBranch].name })
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

    // Config - if admin is logged in use their branch, otherwise host branch
    if (req.url === '/api/config' && req.method === 'GET') {
      const adminBranch = getAdminBranch(req)
      const peopleBranch = adminBranch || hostBranch
      const people = await db.getPeople(peopleBranch)
      json(res, 200, { ...ticketConfigs, people }); return
    }

    // Add person - uses admin's branch
    if (req.url === '/api/people' && req.method === 'POST') {
      const adminBranch = getAdminBranch(req)
      if (!adminBranch) { json(res, 401, { error: 'Unauthorized' }); return }
      const { name } = JSON.parse(await readBody(req))
      if (!name?.trim()) { json(res, 400, { error: 'Missing name' }); return }
      try { await db.addPerson(name.trim(), adminBranch) } catch (e) { json(res, 400, { error: 'Person already exists' }); return }
      json(res, 201, { people: await db.getPeople(adminBranch) }); return
    }

    // Remove person - uses admin's branch
    if (req.url.startsWith('/api/people/') && req.method === 'DELETE') {
      const adminBranch = getAdminBranch(req)
      if (!adminBranch) { json(res, 401, { error: 'Unauthorized' }); return }
      const name = decodeURIComponent(req.url.split('/api/people/')[1])
      const removed = await db.removePerson(name, adminBranch)
      if (!removed) { json(res, 404, { error: 'Person not found' }); return }
      json(res, 200, { people: await db.getPeople(adminBranch) }); return
    }

    // Create ticket - uses the host branch
    if (req.url === '/api/tickets' && req.method === 'POST') {
      const data = JSON.parse(await readBody(req))
      const { name, department, environment, equipmentType, faultType, phone, subject, description } = data
      if (!name || !department || !environment || !equipmentType || !subject || !description) {
        json(res, 400, { error: 'Missing required fields' }); return
      }
      const branchKey = hostBranch === 'main' ? 'main' : BRANCHES[hostBranch].prefix
      const id = await db.generateId(branchKey)
      const now = new Date().toISOString()
      const ticket = { id, name, department, environment, equipmentType, faultType: faultType || '', phone: phone || '', subject, description, status: 'פתוח', techOnCall: '', assignee: '', branch: hostBranch, createdAt: now, updatedAt: now, notes: [] }
      await db.createTicket(ticket)
      json(res, 201, { ...ticket, sla: calculateSLA(now) }); return
    }

    // Public ticket status lookup
    if (req.url.match(/^\/api\/tickets\/[A-Za-z]?[0-9]+\/status$/) && req.method === 'GET') {
      const rawId = req.url.split('/')[3]
      const letterMatch = rawId.match(/^([A-Za-z]?)(\d+)$/i)
      if (!letterMatch) { json(res, 404, { error: 'תקלה לא נמצאה' }); return }
      let prefix = letterMatch[1].toUpperCase()
      const num = String(parseInt(letterMatch[2])).padStart(5, '0')

      // Sub-branch: if no prefix given, auto-add the branch prefix
      if (!prefix && hostBranch !== 'main') {
        prefix = BRANCHES[hostBranch].prefix
      }
      // Main branch: no prefix means main ticket (no letter)
      // Main branch with prefix: search that branch's ticket

      const id = prefix + num
      const ticket = await db.getTicket(id)
      if (!ticket) { json(res, 404, { error: 'תקלה לא נמצאה' }); return }

      // Sub-branch can only see their own tickets
      if (hostBranch !== 'main' && ticket.branch !== hostBranch) {
        json(res, 404, { error: 'תקלה לא נמצאה' }); return
      }

      json(res, 200, {
        id: ticket.id, name: ticket.name, subject: ticket.subject, description: ticket.description,
        status: ticket.status, createdAt: ticket.createdAt, closedAt: ticket.closedAt || null,
        closeReason: ticket.closeReason || null, escalatedTo: ticket.escalatedTo || null
      }); return
    }

    // List tickets (admin) - filtered by admin's branch
    if (req.url === '/api/tickets' && req.method === 'GET') {
      const adminBranch = getAdminBranch(req)
      if (!adminBranch) { json(res, 401, { error: 'Unauthorized' }); return }
      const tickets = await db.getAllTickets(adminBranch)
      json(res, 200, tickets.map(t => ({ ...t, sla: calculateSLA(t.createdAt) }))); return
    }

    // Get ticket (admin)
    if (req.url.match(/^\/api\/tickets\/[A-Z]?[0-9]+$/) && req.method === 'GET') {
      if (!isAdmin(req)) { json(res, 401, { error: 'Unauthorized' }); return }
      const ticket = await db.getTicket(req.url.split('/')[3])
      if (!ticket) { json(res, 404, { error: 'Ticket not found' }); return }
      json(res, 200, { ...ticket, sla: calculateSLA(ticket.createdAt) }); return
    }

    // Escalate ticket (sub-branch admin only)
    if (req.url.match(/^\/api\/tickets\/[A-Z][0-9]+\/escalate$/) && req.method === 'POST') {
      const adminBranch = getAdminBranch(req)
      if (!adminBranch) { json(res, 401, { error: 'Unauthorized' }); return }
      if (adminBranch === 'main') { json(res, 400, { error: 'נפה ראשית לא יכולה להסלים' }); return }

      const id = req.url.split('/')[3]
      const ticket = await db.getTicket(id)
      if (!ticket) { json(res, 404, { error: 'Ticket not found' }); return }
      if (ticket.branch !== adminBranch) { json(res, 403, { error: 'אין הרשאה' }); return }
      if (ticket.escalatedTo) { json(res, 400, { error: 'תקלה כבר הוסלמה' }); return }

      const data = JSON.parse(await readBody(req))
      // Escalation policy: age > 30
      const age = parseInt(data.age)
      if (!age || age <= 30) {
        json(res, 400, { error: 'לא ניתן להסלים: יש להיות מעל גיל 30' }); return
      }

      ticket.escalatedTo = 'main'
      ticket.updatedAt = new Date().toISOString()
      await db.updateTicket(id, ticket)
      json(res, 200, { ...ticket, sla: calculateSLA(ticket.createdAt) }); return
    }

    // Update ticket (admin)
    if (req.url.match(/^\/api\/tickets\/[A-Z]?[0-9]+$/) && req.method === 'PATCH') {
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
    if (req.url.match(/^\/api\/tickets\/[A-Z]?[0-9]+$/) && req.method === 'DELETE') {
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
    console.log('🔑 Admin logins:')
    for (const [key, b] of Object.entries(BRANCHES)) {
      console.log(`   ${b.name} (${key}): ${b.admin} / ${b.pass}`)
    }
  })
}).catch(err => {
  console.error('❌ Failed to initialize database:', err)
  process.exit(1)
})
