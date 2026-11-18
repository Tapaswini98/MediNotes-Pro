import os
from pathlib import Path
from fastapi import FastAPI, Depends, File, UploadFile
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from fastapi_clerk_auth import ClerkConfig, ClerkHTTPBearer, HTTPAuthorizationCredentials
from openai import OpenAI
import resend

app = FastAPI()

# Add CORS middleware (allows frontend to call backend)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Clerk authentication setup
clerk_config = ClerkConfig(jwks_url=os.getenv("CLERK_JWKS_URL"))
clerk_guard = ClerkHTTPBearer(clerk_config)

resend.api_key = os.getenv("RESEND_API_KEY")
RESEND_FROM_EMAIL = os.getenv("RESEND_FROM_EMAIL")


class Visit(BaseModel):
    patient_name: str
    date_of_visit: str
    notes: str
    practice_email: str | None = None


system_prompt = """
You are provided with notes written by a doctor from a patient's visit.
Your job is to summarize the visit for the doctor and provide an email.
Reply with exactly three sections with the headings:
### Summary of visit for the doctor's records
### Next steps for the doctor
### Draft of email to patient in patient-friendly language
"""


def user_prompt_for(visit: Visit) -> str:
    return f"""Create the summary, next steps and draft email for:
Patient Name: {visit.patient_name}
Date of Visit: {visit.date_of_visit}
Notes:
{visit.notes}"""


def send_summary_email(visit: Visit, summary: str) -> None:
    if not (resend.api_key and RESEND_FROM_EMAIL and visit.practice_email):
        return
    try:
        resend.Emails.send({
            "from": RESEND_FROM_EMAIL,
            "to": [visit.practice_email],
            "subject": f"Visit summary for {visit.patient_name} ({visit.date_of_visit})",
            "text": summary,
        })
    except Exception as e:
        print(f"Failed to send summary email: {e}")


@app.post("/api/consultation")
def consultation_summary(
    visit: Visit,
    creds: HTTPAuthorizationCredentials = Depends(clerk_guard),
):
    user_id = creds.decoded["sub"]  # Available for tracking/auditing
    client = OpenAI()

    user_prompt = user_prompt_for(visit)
    prompt = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    stream = client.chat.completions.create(
        model="gpt-5-nano",
        messages=prompt,
        stream=True,
    )

    def event_stream():
        full_text = ""
        for chunk in stream:
            text = chunk.choices[0].delta.content
            if text:
                full_text += text
                lines = text.split("\n")
                for line in lines[:-1]:
                    yield f"data: {line}\n\n"
                    yield "data:  \n"
                yield f"data: {lines[-1]}\n\n"
        send_summary_email(visit, full_text)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/api/transcribe")
async def transcribe_audio(
    audio: UploadFile = File(...),
    creds: HTTPAuthorizationCredentials = Depends(clerk_guard),
):
    client = OpenAI()
    audio_bytes = await audio.read()
    transcript = client.audio.transcriptions.create(
        model="gpt-4o-mini-transcribe",
        file=(audio.filename or "recording.webm", audio_bytes, audio.content_type or "audio/webm"),
    )
    return {"text": transcript.text}


@app.get("/health")
def health_check():
    """Health check endpoint (used for local Docker; Lambda does not invoke it)"""
    return {"status": "healthy"}

# Serve static files (our Next.js export) - MUST BE LAST!
static_path = Path("static")
if static_path.exists():
    @app.get("/")
    async def serve_root():
        return FileResponse(static_path / "index.html")

    # Next.js static export writes clean routes like /product as product.html,
    # but StaticFiles only auto-resolves index.html for directory requests —
    # without this, refreshing or deep-linking to /product 404s.
    @app.get("/product")
    async def serve_product():
        return FileResponse(static_path / "product.html")

    app.mount("/", StaticFiles(directory="static", html=True), name="static")
