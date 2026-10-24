from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .recommend import aclose_client
from .recommend import router as recommend_router
from .telemetry import router as telemetry_router


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await aclose_client()


app = FastAPI(title="EdgeSense API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(recommend_router)
app.include_router(telemetry_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
