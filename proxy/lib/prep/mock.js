// Deterministic, clearly-illustrative stand-ins for sources that are not
// live-integrated in subsystem A (documents/RFPs, attendee web research,
// calendar). Seeded off names so output is stable across runs and tests.

function hash(str) {
  let h = 0
  for (let i = 0; i < String(str).length; i++) {
    h = (h * 31 + String(str).charCodeAt(i)) >>> 0
  }
  return h
}

function daysFromNow(n) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

export function mockRfps(account) {
  const name = account?.name || 'Account'
  const h = hash(name)
  const kinds = ['Managed Services', 'Platform Migration', 'Support Renewal']
  return [
    { title: `${name} — ${kinds[h % kinds.length]} RFP`, date: daysFromNow(-(10 + (h % 20))), status: 'Under review' },
    { title: `${name} — Annual Procurement RFP`, date: daysFromNow(-(45 + (h % 30))), status: 'Submitted' },
  ]
}

export function mockAttendeeResearch(contacts) {
  const list = Array.isArray(contacts) ? contacts : []
  const firms = ['Acme Corp', 'Globex', 'Initech', 'Umbrella', 'Hooli']
  const schools = ['MIT', 'Stanford', 'INSEAD', 'LBS', 'Wharton']
  return list.map((c) => {
    const h = hash(c.name || 'contact')
    const years = 3 + (h % 12)
    return {
      name: c.name,
      title: c.title || 'Unknown role',
      summary: `Illustrative research (mock): ${c.name} has ~${years} years in ${c.title || 'their role'}.`,
      career: [
        `Currently ${c.title || 'role'} (${years} yrs)`,
        `Previously at ${firms[h % firms.length]}`,
        `Earlier at ${firms[(h + 2) % firms.length]}`,
      ],
      education: `${schools[h % schools.length]}`,
    }
  })
}

export function mockCalendar(account) {
  const name = account?.name || 'Account'
  return {
    subject: `${name} — Quarterly Business Review`,
    date: daysFromNow(1),
    location: 'Video call',
  }
}
