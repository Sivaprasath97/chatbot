import os
import asyncio
from datetime import datetime
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Optional
from dotenv import load_dotenv
from groq import AsyncGroq
from motor.motor_asyncio import AsyncIOMotorClient

# Load environment variables from .env
load_dotenv()

# Initialize FastAPI app
app = FastAPI(
    title="AI Chatbot API",
    description="Backend API for the AI Chatbot application powered by Groq LLM & MongoDB Atlas",
    version="1.1.0"
)

# Enable CORS for development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Check for Groq API key configuration
api_key = os.getenv("GROQ_API_KEY")
IS_API_KEY_CONFIGURED = api_key and api_key != "your_groq_api_key_here"

# Initialize AsyncGroq client
if IS_API_KEY_CONFIGURED:
    client = AsyncGroq(api_key=api_key)
else:
    client = None

# MongoDB Atlas configuration
mongo_uri = os.getenv("MONGO_URI")
db_name = "chatbot-ai"
IS_MONGO_CONFIGURED = mongo_uri and "mongodb" in mongo_uri

if IS_MONGO_CONFIGURED:
    try:
        db_client = AsyncIOMotorClient(mongo_uri)
        db = db_client[db_name]
        conversations_col = db["conversations"]
    except Exception as e:
        print(f"MongoDB connection initialization failed: {e}")
        IS_MONGO_CONFIGURED = False
        db_client = None
        conversations_col = None
else:
    db_client = None
    conversations_col = None

# Pydantic schemas
class ChatMessage(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    chat_id: str
    message: ChatMessage
    model: str = "llama-3.3-70b-versatile"

class CreateChatRequest(BaseModel):
    id: str
    title: str
    model: str

@app.get("/api/config")
async def get_config():
    """Returns application configuration and database status."""
    is_db_connected = False
    if IS_MONGO_CONFIGURED and db_client:
        try:
            # Check connection using a ping
            await db_client.admin.command('ping')
            is_db_connected = True
        except Exception as e:
            print(f"MongoDB ping failed: {e}")
            is_db_connected = False
            
    return {
        "is_api_key_configured": IS_API_KEY_CONFIGURED,
        "is_db_connected": is_db_connected,
        "default_model": "llama-3.3-70b-versatile",
        "available_models": [
            {"id": "llama-3.3-70b-versatile", "name": "Llama 3.3 70B (Versatile)"},
            {"id": "mixtral-8x7b-32768", "name": "Mixtral 8x7B"},
            {"id": "gemma2-9b-it", "name": "Gemma 2 9B IT"}
        ]
    }

@app.get("/api/chats")
async def list_chats():
    """Lists all chat conversations in MongoDB, omitting detailed message content."""
    if not IS_MONGO_CONFIGURED or conversations_col is None:
        return []
    try:
        cursor = conversations_col.find({}, {"messages": 0}).sort("updated_at", -1)
        chats = []
        async for doc in cursor:
            chats.append({
                "id": doc["_id"],
                "title": doc.get("title", "New Conversation"),
                "model": doc.get("model", "llama-3.3-70b-versatile"),
                "updated_at": doc.get("updated_at", "")
            })
        return chats
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

@app.get("/api/chats/{chat_id}")
async def get_chat_details(chat_id: str):
    """Fetches full chat details (including messages) from MongoDB."""
    if not IS_MONGO_CONFIGURED or conversations_col is None:
        raise HTTPException(status_code=503, detail="Database connection not available")
    try:
        doc = await conversations_col.find_one({"_id": chat_id})
        if not doc:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return {
            "id": doc["_id"],
            "title": doc.get("title", "New Conversation"),
            "model": doc.get("model", "llama-3.3-70b-versatile"),
            "messages": doc.get("messages", [])
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

@app.post("/api/chats")
async def create_chat(request: CreateChatRequest):
    """Creates a new conversation record in MongoDB."""
    if not IS_MONGO_CONFIGURED or conversations_col is None:
        raise HTTPException(status_code=503, detail="Database connection not available")
    try:
        existing = await conversations_col.find_one({"_id": request.id})
        if existing:
            return {"status": "success", "message": "Conversation already exists"}
            
        new_doc = {
            "_id": request.id,
            "title": request.title,
            "model": request.model,
            "messages": [],
            "updated_at": datetime.utcnow().isoformat()
        }
        await conversations_col.insert_one(new_doc)
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

@app.delete("/api/chats/{chat_id}")
async def delete_chat(chat_id: str):
    """Removes a conversation record from MongoDB."""
    if not IS_MONGO_CONFIGURED or conversations_col is None:
        raise HTTPException(status_code=503, detail="Database connection not available")
    try:
        result = await conversations_col.delete_one({"_id": chat_id})
        if result.deleted_count == 0:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return {"status": "success"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

@app.post("/api/chat")
async def chat_endpoint(request: ChatRequest):
    """Processes chat request, streams response from Groq, and persists history in MongoDB."""
    if not IS_API_KEY_CONFIGURED or not client:
        return StreamingResponse(
            (chunk for chunk in [
                "⚠️ API Key Error: Please set your valid `GROQ_API_KEY` in the `.env` file in the project directory, then restart the server."
            ]),
            media_type="text/plain"
        )
    
    if not IS_MONGO_CONFIGURED or conversations_col is None:
        return StreamingResponse(
            (chunk for chunk in [
                "⚠️ Database Error: MongoDB Atlas is not connected. Please verify your `MONGO_URI` connection settings in `.env`."
            ]),
            media_type="text/plain"
        )

    try:
        # Fetch conversation history from MongoDB
        conv = await conversations_col.find_one({"_id": request.chat_id})
        if not conv:
            # If conversation record is missing, initialize it
            conv = {
                "_id": request.chat_id,
                "title": request.message.content[:30] + ("..." if len(request.message.content) > 30 else ""),
                "model": request.model,
                "messages": [],
                "updated_at": datetime.utcnow().isoformat()
            }
            await conversations_col.insert_one(conv)
        
        history = conv.get("messages", [])
        
        # Add new user message to history
        new_user_message = {"role": request.message.role, "content": request.message.content}
        history.append(new_user_message)
        
        # Push user message to MongoDB database and update metadata
        auto_title = request.message.content[:30] + ("..." if len(request.message.content) > 30 else "")
        title_to_set = conv.get("title", "New Conversation")
        if title_to_set == "New Conversation":
            title_to_set = auto_title
            
        await conversations_col.update_one(
            {"_id": request.chat_id},
            {
                "$push": {"messages": new_user_message},
                "$set": {
                    "updated_at": datetime.utcnow().isoformat(),
                    "title": title_to_set
                }
            }
        )
    except Exception as e:
        return StreamingResponse(
            (chunk for chunk in [f"🚨 *Database Read/Write Error:* {str(e)}"]),
            media_type="text/plain"
        )

    async def response_streamer():
        assistant_reply = ""
        try:
            # Format messages list for Groq API integration
            formatted_messages = [{"role": msg["role"], "content": msg["content"]} for msg in history]
            
            # Query Groq API with stream=True
            chat_completion = await client.chat.completions.create(
                messages=formatted_messages,
                model=request.model,
                stream=True,
            )
            async for chunk in chat_completion:
                content = chunk.choices[0].delta.content
                if content is not None:
                    assistant_reply += content
                    yield content
                    
            # Persist completed assistant response in MongoDB Atlas database
            if assistant_reply:
                new_bot_message = {"role": "assistant", "content": assistant_reply}
                await conversations_col.update_one(
                    {"_id": request.chat_id},
                    {
                        "$push": {"messages": new_bot_message},
                        "$set": {"updated_at": datetime.utcnow().isoformat()}
                    }
                )
        except Exception as e:
            # Send error text back to front UI stream
            yield f"\n\n🚨 *Backend Stream Error:* {str(e)}"

    return StreamingResponse(response_streamer(), media_type="text/plain")

# Mount the static directory
static_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
os.makedirs(static_dir, exist_ok=True)
app.mount("/static", StaticFiles(directory=static_dir), name="static")

@app.get("/")
async def read_index():
    """Serves the main application landing page."""
    index_path = os.path.join(static_dir, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return {
        "message": "FastAPI server is running. Create static/index.html to view the frontend."
    }

if __name__ == "__main__":
    import uvicorn
    # Start ASGI server
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
