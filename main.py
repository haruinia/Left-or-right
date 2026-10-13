from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import base64
from typing import List, Optional

app = FastAPI()

class ChatRequest(BaseModel):
    text: str
    images: List[str]
    history: List[dict]

@app.post("/api/chat/stream")
async def chat_stream(request: ChatRequest):
    # Mock response for testing
    if not request.images:
        raise HTTPException(status_code=400, detail="Missing screenshot")
    
    # Return mock SSE stream
    return "data: {\"delta\": \"这道题考察的是...\"}\n\ndata: {\"done\": true}\n\n"

@app.get("/health")
async def health():
    return {"status": "ok", "service": "shuihuo-killer-gateway"}
