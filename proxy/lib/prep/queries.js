export function accountByIdSoql(id) {
  return (
    `SELECT Id, Name, Industry, Type, Website, Phone, AnnualRevenue, ` +
    `BillingCity, BillingState, Description, LastActivityDate ` +
    `FROM Account WHERE Id = '${id}' LIMIT 1`
  )
}

export function opportunitiesSoql(accountId) {
  return (
    `SELECT Id, Name, Amount, StageName, CloseDate, IsClosed, IsWon ` +
    `FROM Opportunity WHERE AccountId = '${accountId}' ` +
    `ORDER BY CloseDate DESC NULLS LAST LIMIT 25`
  )
}

export function casesSoql(accountId) {
  return (
    `SELECT Id, CaseNumber, Subject, Status, Priority, CreatedDate, IsClosed ` +
    `FROM Case WHERE AccountId = '${accountId}' ` +
    `ORDER BY CreatedDate DESC LIMIT 25`
  )
}

export function contactsSoql(accountId) {
  return (
    `SELECT Id, Name, Title, Email, Department ` +
    `FROM Contact WHERE AccountId = '${accountId}' ` +
    `ORDER BY CreatedDate DESC LIMIT 15`
  )
}
