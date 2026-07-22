# Live Meeting Companion — How It Works

> **Even Realities G2 Glasses × Salesforce × AI**

---

## The Three Lanes

| 🥽 **You & Your Glasses** | 🤖 **AI Behind the Scenes** | ☁️ **Salesforce** |
|:---|:---|:---|
| What you physically do | What's processing invisibly | What's read or written |

---

## ① Before the Meeting

| 🥽 You & Your Glasses | 🤖 AI Behind the Scenes | ☁️ Salesforce |
|:---|:---|:---|
| Open the app on your glasses. You see your Salesforce accounts list. Tap to open one. | | Account data is fetched in real time — pipeline value, open deals, contacts, and last interaction. |
| ↓ | | ↓ |
| Your glasses display a pipeline chart, contacts, and AI-generated talking points. | AI reads the account's deals and history, then writes 3–5 focused talking points for you. | |

---

## ② Starting the Meeting

| 🥽 You & Your Glasses | 🤖 AI Behind the Scenes | ☁️ Salesforce |
|:---|:---|:---|
| **Double-tap** on the account detail view. The display switches to meeting mode. The mic turns on and a timer starts. | Your 3 best talking points appear instantly as opening cues — no speech needed yet. | The account's Meeting Prep record is loaded to anchor all AI suggestions throughout the call. |

---

## ③ During the Meeting *(repeats every ~5 seconds)*

| 🥽 You & Your Glasses | 🤖 AI Behind the Scenes | ☁️ Salesforce |
|:---|:---|:---|
| You speak naturally. The glasses listen silently in the background. | | |
| ↓ | | |
| The display briefly shows **● REC ↻** while your last few seconds of speech are being processed. | Your audio clip is converted to text using OpenAI Whisper. | |
| | ↓ | |
| **New cues appear** — 2–3 suggestions specific to what was just said in the room. | AI combines what you just said + the full conversation so far + your prep points, and writes targeted next-step cues. | |

---

## ④ Ending the Meeting

| 🥽 You & Your Glasses | 🤖 AI Behind the Scenes | ☁️ Salesforce |
|:---|:---|:---|
| **Single-tap** to end and save. The mic turns off. The glasses show *"Summarising & saving…"* | AI reads the full conversation transcript and produces a summary, action items, and next steps. | |
| | ↓ | |
| | | A **Meeting Note** is created automatically on the account — summary, action items, next steps, and timestamp. No typing required. |
| ↓ | | |
| You see the summary, action items, and **"Saved to Salesforce ✓"** on the glasses. Tap back to your accounts list. | | |

---

## At a Glance

```
BEFORE          Open account → AI reads Salesforce data → Talking points appear on glasses
                                                                            │
START           Double-tap ──────────────────────────────────────────────── Prep record loaded
                                                                            │
DURING          Speak → Glasses capture audio every 5s
                              │
                        Whisper transcribes
                              │
                        GPT generates cues  ←── "what you just said" + full transcript + prep
                              │
                        Cues update on glasses display
                                                                            │
END             Single-tap → GPT summarises conversation ────────────────── Meeting Note saved to Salesforce
                              │
                        Summary shown on glasses ✓
```

---

*Built on: Even Hub SDK · OpenAI Whisper (speech-to-text) · GPT-4o-mini (cues & summary) · Salesforce (accounts, prep, meeting notes)*
