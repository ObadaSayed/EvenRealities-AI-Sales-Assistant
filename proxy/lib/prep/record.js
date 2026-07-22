export function buildMeetingPrepRecord({
  account,
  brief,
  attendees,
  meetingDate,
  transcript,
  status,
}) {
  return {
    Account__c: account?.id ?? null,
    Brief__c: brief ?? '',
    Attendees__c: attendees ?? '',
    Meeting_Date__c: meetingDate ?? null,
    Status__c: status ?? 'Draft',
    Source__c: 'glasses-voice',
    Transcript__c: String(transcript ?? '').slice(0, 255),
  }
}

export async function writeMeetingPrep({ createRecord, record }) {
  const res = await createRecord('Meeting_Prep__c', record)
  const id = res?.id || res?.Id
  if (!id) throw new Error('create returned no id')
  return id
}
