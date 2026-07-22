function bulletJoin(items) {
  return (items || []).map((i) => `- ${i}`).join('\n')
}

export function buildMeetingNoteRecord({
  accountId,
  prepId,
  transcript,
  summary,
  actionItems,
  nextSteps,
  startedAt,
}) {
  const record = {
    Account__c: accountId ?? null,
    Meeting_Date__c: new Date(startedAt || Date.now()).toISOString(),
    Transcript__c: String(transcript ?? ''),
    Summary__c: String(summary ?? ''),
    Action_Items__c: bulletJoin(actionItems),
    Next_Steps__c: bulletJoin(nextSteps),
  }
  if (prepId) record.Meeting_Prep__c = prepId
  return record
}

export async function writeMeetingNote({ createRecord, record }) {
  const res = await createRecord('Meeting_Note__c', record)
  const id = res?.id || res?.Id
  if (!id) throw new Error('create returned no id')
  return { id }
}
