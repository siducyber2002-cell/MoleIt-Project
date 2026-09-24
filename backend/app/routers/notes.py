import os
import uuid

from fastapi import APIRouter, Depends, UploadFile, File
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..auth import get_current_user
from ..exceptions import BadRequestError, NotFoundError
from ..logging_config import get_logger
from ..responses import ok, err, serialize, serialize_list

logger = get_logger(__name__)

router = APIRouter(prefix="/api/notes", tags=["notes"])

UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

MAX_UPLOAD_SIZE = 15 * 1024 * 1024  # 15 MB per file
ALLOWED_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp",
    ".pdf", ".doc", ".docx", ".txt", ".csv", ".xlsx",
}


@router.get("")
def list_notes(
    db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)
):
    logger.info("Listing notes for user_id=%s", current_user.id)
    try:
        results = (
            db.query(models.Note)
            .filter(models.Note.owner_id == current_user.id)
            .order_by(models.Note.updated_at.desc())
            .all()
        )
        logger.info("Listing notes succeeded | user_id=%s count=%d", current_user.id, len(results))
        return ok(200, "Notes fetched successfully", notes=serialize_list(schemas.NoteOut, results))
    except Exception:
        logger.error("Listing notes crashed | user_id=%s", current_user.id, exc_info=True)
        return err(500, "Internal server error")


@router.post("")
def create_note(
    payload: schemas.NoteCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    logger.info("Create note requested | user_id=%s title=%r", current_user.id, payload.title)
    try:
        note = models.Note(
            title=payload.title,
            content=payload.content,
            compound_id=payload.compound_id,
            folder=payload.folder,
            embedded_molecules=payload.embedded_molecules,
            attachments=[],
            owner_id=current_user.id,
        )
        db.add(note)
        db.commit()
        db.refresh(note)
        logger.info("Create note succeeded | user_id=%s note_id=%s", current_user.id, note.id)
        return ok(201, "Note created successfully", note=serialize(schemas.NoteOut, note))
    except Exception:
        logger.error("Create note crashed | user_id=%s", current_user.id, exc_info=True)
        return err(500, "Internal server error")


@router.put("/{note_id}")
def update_note(
    note_id: str,
    payload: schemas.NoteUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    logger.info("Update note requested | user_id=%s note_id=%s", current_user.id, note_id)
    try:
        note = (
            db.query(models.Note)
            .filter(models.Note.id == note_id, models.Note.owner_id == current_user.id)
            .first()
        )
        if not note:
            raise NotFoundError("Note not found")

        for field, value in payload.model_dump(exclude_unset=True).items():
            setattr(note, field, value)

        db.commit()
        db.refresh(note)
        logger.info("Update note succeeded | user_id=%s note_id=%s", current_user.id, note_id)
        return ok(200, "Note updated successfully", note=serialize(schemas.NoteOut, note))
    except NotFoundError as e:
        logger.warning("Update note failed | user_id=%s note_id=%s reason=%s", current_user.id, note_id, e)
        return err(404, str(e))
    except Exception:
        logger.error("Update note crashed | user_id=%s note_id=%s", current_user.id, note_id, exc_info=True)
        return err(500, "Internal server error")


@router.delete("/{note_id}")
def delete_note(
    note_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    logger.info("Delete note requested | user_id=%s note_id=%s", current_user.id, note_id)
    try:
        note = (
            db.query(models.Note)
            .filter(models.Note.id == note_id, models.Note.owner_id == current_user.id)
            .first()
        )
        if not note:
            raise NotFoundError("Note not found")

        for att in note.attachments or []:
            try:
                path = os.path.join(UPLOAD_DIR, att["id"] + os.path.splitext(att["filename"])[1])
                if os.path.exists(path):
                    os.remove(path)
            except Exception:
                logger.warning(
                    "Delete note: failed to remove attachment file from disk (continuing) | note_id=%s attachment=%r",
                    note_id, att, exc_info=True,
                )

        db.delete(note)
        db.commit()
        logger.info("Delete note succeeded | user_id=%s note_id=%s", current_user.id, note_id)
        return ok(200, "Note deleted successfully")
    except NotFoundError as e:
        logger.warning("Delete note failed | user_id=%s note_id=%s reason=%s", current_user.id, note_id, e)
        return err(404, str(e))
    except Exception:
        logger.error("Delete note crashed | user_id=%s note_id=%s", current_user.id, note_id, exc_info=True)
        return err(500, "Internal server error")


@router.post("/{note_id}/attachments")
async def upload_attachment(
    note_id: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    logger.info(
        "Upload attachment requested | user_id=%s note_id=%s filename=%r",
        current_user.id, note_id, file.filename,
    )
    try:
        note = (
            db.query(models.Note)
            .filter(models.Note.id == note_id, models.Note.owner_id == current_user.id)
            .first()
        )
        if not note:
            raise NotFoundError("Note not found")

        ext = os.path.splitext(file.filename or "")[1].lower()
        if ext not in ALLOWED_EXTENSIONS:
            raise BadRequestError(f"File type '{ext}' isn't supported.")

        contents = await file.read()
        if len(contents) > MAX_UPLOAD_SIZE:
            raise BadRequestError("File is larger than the 15MB limit.")

        attachment_id = str(uuid.uuid4())
        stored_filename = f"{attachment_id}{ext}"
        stored_path = os.path.join(UPLOAD_DIR, stored_filename)
        try:
            with open(stored_path, "wb") as f:
                f.write(contents)
        except OSError as exc:
            logger.error("Upload attachment failed: could not write file to disk | note_id=%s error=%s", note_id, exc, exc_info=True)
            return err(500, "Could not save the uploaded file.")

        attachment = {
            "id": attachment_id,
            "filename": file.filename,
            "url": f"/uploads/{stored_filename}",
            "content_type": file.content_type,
            "size": len(contents),
        }

        note.attachments = [*(note.attachments or []), attachment]
        db.commit()
        logger.info("Upload attachment succeeded | note_id=%s attachment_id=%s size=%d", note_id, attachment_id, len(contents))
        return ok(201, "Attachment uploaded successfully", attachment=attachment)

    except NotFoundError as e:
        logger.warning("Upload attachment failed | note_id=%s reason=%s", note_id, e)
        return err(404, str(e))
    except BadRequestError as e:
        logger.warning("Upload attachment failed | note_id=%s reason=%s", note_id, e)
        return err(400, str(e))
    except Exception:
        logger.error("Upload attachment crashed | note_id=%s", note_id, exc_info=True)
        return err(500, "Internal server error")


@router.delete("/{note_id}/attachments/{attachment_id}")
def delete_attachment(
    note_id: str,
    attachment_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    logger.info("Delete attachment requested | user_id=%s note_id=%s attachment_id=%s", current_user.id, note_id, attachment_id)
    try:
        note = (
            db.query(models.Note)
            .filter(models.Note.id == note_id, models.Note.owner_id == current_user.id)
            .first()
        )
        if not note:
            raise NotFoundError("Note not found")

        remaining = []
        removed = None
        for att in note.attachments or []:
            if att["id"] == attachment_id:
                removed = att
            else:
                remaining.append(att)

        if not removed:
            raise NotFoundError("Attachment not found")

        try:
            ext = os.path.splitext(removed["filename"])[1].lower()
            path = os.path.join(UPLOAD_DIR, removed["id"] + ext)
            if os.path.exists(path):
                os.remove(path)
        except Exception:
            logger.warning("Delete attachment: failed to remove file from disk (continuing) | attachment_id=%s", attachment_id, exc_info=True)

        note.attachments = remaining
        db.commit()
        logger.info("Delete attachment succeeded | note_id=%s attachment_id=%s", note_id, attachment_id)
        return ok(200, "Attachment deleted successfully")
    except NotFoundError as e:
        logger.warning("Delete attachment failed | note_id=%s attachment_id=%s reason=%s", note_id, attachment_id, e)
        return err(404, str(e))
    except Exception:
        logger.error("Delete attachment crashed | note_id=%s attachment_id=%s", note_id, attachment_id, exc_info=True)
        return err(500, "Internal server error")