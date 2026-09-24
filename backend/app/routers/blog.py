import os
import uuid

from fastapi import APIRouter, Depends, UploadFile, File
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..auth import get_current_user
from ..exceptions import BadRequestError, ForbiddenError, NotFoundError
from ..logging_config import get_logger
from ..responses import ok, err, serialize, serialize_list

logger = get_logger(__name__)

router = APIRouter(prefix="/api/blog", tags=["blog"])

UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

MAX_UPLOAD_SIZE = 15 * 1024 * 1024  # 15 MB per file
ALLOWED_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp",
    ".pdf", ".doc", ".docx", ".txt", ".csv", ".xlsx",
}


# ---- Posts ----

@router.get("")
def list_posts(db: Session = Depends(get_db)):
    """Public, no auth — every student's blog posts, newest first."""
    logger.info("List blog posts requested")
    try:
        results = db.query(models.BlogPost).order_by(models.BlogPost.created_at.desc()).all()
        logger.info("List blog posts succeeded | count=%d", len(results))
        return ok(200, "Posts fetched successfully", posts=serialize_list(schemas.BlogPostOut, results))
    except Exception:
        logger.error("List blog posts crashed", exc_info=True)
        return err(500, "Internal server error")


@router.get("/{post_id}")
def get_post(post_id: str, db: Session = Depends(get_db)):
    logger.info("Get blog post requested | post_id=%s", post_id)
    try:
        post = db.query(models.BlogPost).filter(models.BlogPost.id == post_id).first()
        if not post:
            raise NotFoundError("Post not found")
        logger.info("Get blog post succeeded | post_id=%s", post_id)
        return ok(200, "Post fetched successfully", post=serialize(schemas.BlogPostOut, post))
    except NotFoundError as e:
        logger.warning("Get blog post failed | post_id=%s reason=%s", post_id, e)
        return err(404, str(e))
    except Exception:
        logger.error("Get blog post crashed | post_id=%s", post_id, exc_info=True)
        return err(500, "Internal server error")


@router.post("")
def create_post(
    payload: schemas.BlogPostCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    logger.info("Create blog post requested | user_id=%s title=%r", current_user.id, payload.title)
    try:
        post = models.BlogPost(
            title=payload.title.strip(),
            content=payload.content,
            attachments=[],
            author_id=current_user.id,
        )
        db.add(post)
        db.commit()
        db.refresh(post)
        logger.info("Create blog post succeeded | user_id=%s post_id=%s", current_user.id, post.id)
        return ok(201, "Post created successfully", post=serialize(schemas.BlogPostOut, post))
    except Exception:
        logger.error("Create blog post crashed | user_id=%s", current_user.id, exc_info=True)
        return err(500, "Internal server error")


@router.put("/{post_id}")
def update_post(
    post_id: str,
    payload: schemas.BlogPostUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    logger.info("Update blog post requested | user_id=%s post_id=%s", current_user.id, post_id)
    try:
        post = (
            db.query(models.BlogPost)
            .filter(models.BlogPost.id == post_id, models.BlogPost.author_id == current_user.id)
            .first()
        )
        if not post:
            raise NotFoundError("Post not found")

        for field, value in payload.model_dump(exclude_unset=True).items():
            setattr(post, field, value)

        db.commit()
        db.refresh(post)
        logger.info("Update blog post succeeded | user_id=%s post_id=%s", current_user.id, post_id)
        return ok(200, "Post updated successfully", post=serialize(schemas.BlogPostOut, post))
    except NotFoundError as e:
        logger.warning("Update blog post failed | user_id=%s post_id=%s reason=%s", current_user.id, post_id, e)
        return err(404, str(e))
    except Exception:
        logger.error("Update blog post crashed | user_id=%s post_id=%s", current_user.id, post_id, exc_info=True)
        return err(500, "Internal server error")


@router.delete("/{post_id}")
def delete_post(
    post_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    logger.info("Delete blog post requested | user_id=%s post_id=%s", current_user.id, post_id)
    try:
        post = (
            db.query(models.BlogPost)
            .filter(models.BlogPost.id == post_id, models.BlogPost.author_id == current_user.id)
            .first()
        )
        if not post:
            raise NotFoundError("Post not found")

        for att in post.attachments or []:
            try:
                path = os.path.join(UPLOAD_DIR, att["id"] + os.path.splitext(att["filename"])[1])
                if os.path.exists(path):
                    os.remove(path)
            except Exception:
                logger.warning(
                    "Delete blog post: failed to remove attachment file from disk (continuing) | post_id=%s attachment=%r",
                    post_id, att, exc_info=True,
                )

        db.delete(post)  # cascades to comments via the model relationship
        db.commit()
        logger.info("Delete blog post succeeded | user_id=%s post_id=%s", current_user.id, post_id)
        return ok(200, "Post deleted successfully")
    except NotFoundError as e:
        logger.warning("Delete blog post failed | user_id=%s post_id=%s reason=%s", current_user.id, post_id, e)
        return err(404, str(e))
    except Exception:
        logger.error("Delete blog post crashed | user_id=%s post_id=%s", current_user.id, post_id, exc_info=True)
        return err(500, "Internal server error")


# ---- Attachments (author only, post must already exist) ----

@router.post("/{post_id}/attachments")
async def upload_attachment(
    post_id: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    logger.info(
        "Upload blog attachment requested | user_id=%s post_id=%s filename=%r",
        current_user.id, post_id, file.filename,
    )
    try:
        post = (
            db.query(models.BlogPost)
            .filter(models.BlogPost.id == post_id, models.BlogPost.author_id == current_user.id)
            .first()
        )
        if not post:
            raise NotFoundError("Post not found")

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
            logger.error("Upload blog attachment failed: could not write file to disk | post_id=%s error=%s", post_id, exc, exc_info=True)
            return err(500, "Could not save the uploaded file.")

        attachment = {
            "id": attachment_id,
            "filename": file.filename,
            "url": f"/uploads/{stored_filename}",
            "content_type": file.content_type,
            "size": len(contents),
        }

        post.attachments = [*(post.attachments or []), attachment]
        db.commit()
        logger.info("Upload blog attachment succeeded | post_id=%s attachment_id=%s size=%d", post_id, attachment_id, len(contents))
        return ok(201, "Attachment uploaded successfully", attachment=attachment)

    except NotFoundError as e:
        logger.warning("Upload blog attachment failed | post_id=%s reason=%s", post_id, e)
        return err(404, str(e))
    except BadRequestError as e:
        logger.warning("Upload blog attachment failed | post_id=%s reason=%s", post_id, e)
        return err(400, str(e))
    except Exception:
        logger.error("Upload blog attachment crashed | post_id=%s", post_id, exc_info=True)
        return err(500, "Internal server error")


@router.delete("/{post_id}/attachments/{attachment_id}")
def delete_attachment(
    post_id: str,
    attachment_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    logger.info("Delete blog attachment requested | user_id=%s post_id=%s attachment_id=%s", current_user.id, post_id, attachment_id)
    try:
        post = (
            db.query(models.BlogPost)
            .filter(models.BlogPost.id == post_id, models.BlogPost.author_id == current_user.id)
            .first()
        )
        if not post:
            raise NotFoundError("Post not found")

        remaining = []
        removed = None
        for att in post.attachments or []:
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
            logger.warning("Delete blog attachment: failed to remove file from disk (continuing) | attachment_id=%s", attachment_id, exc_info=True)

        post.attachments = remaining
        db.commit()
        logger.info("Delete blog attachment succeeded | post_id=%s attachment_id=%s", post_id, attachment_id)
        return ok(200, "Attachment deleted successfully")
    except NotFoundError as e:
        logger.warning("Delete blog attachment failed | post_id=%s attachment_id=%s reason=%s", post_id, attachment_id, e)
        return err(404, str(e))
    except Exception:
        logger.error("Delete blog attachment crashed | post_id=%s attachment_id=%s", post_id, attachment_id, exc_info=True)
        return err(500, "Internal server error")


# ---- Comments ----

@router.get("/{post_id}/comments")
def list_comments(post_id: str, db: Session = Depends(get_db)):
    """Public, no auth — read the discussion under a post."""
    logger.info("List blog comments requested | post_id=%s", post_id)
    try:
        post = db.query(models.BlogPost).filter(models.BlogPost.id == post_id).first()
        if not post:
            raise NotFoundError("Post not found")
        results = (
            db.query(models.BlogComment)
            .filter(models.BlogComment.post_id == post_id)
            .order_by(models.BlogComment.created_at.asc())
            .all()
        )
        logger.info("List blog comments succeeded | post_id=%s count=%d", post_id, len(results))
        return ok(200, "Comments fetched successfully", comments=serialize_list(schemas.BlogCommentOut, results))
    except NotFoundError as e:
        logger.warning("List blog comments failed | post_id=%s reason=%s", post_id, e)
        return err(404, str(e))
    except Exception:
        logger.error("List blog comments crashed | post_id=%s", post_id, exc_info=True)
        return err(500, "Internal server error")


@router.post("/{post_id}/comments")
def create_comment(
    post_id: str,
    payload: schemas.BlogCommentCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    logger.info("Create blog comment requested | user_id=%s post_id=%s", current_user.id, post_id)
    try:
        post = db.query(models.BlogPost).filter(models.BlogPost.id == post_id).first()
        if not post:
            raise NotFoundError("Post not found")

        comment = models.BlogComment(
            post_id=post_id,
            author_id=current_user.id,
            content=payload.content.strip(),
        )
        db.add(comment)
        db.commit()
        db.refresh(comment)
        logger.info("Create blog comment succeeded | user_id=%s post_id=%s comment_id=%s", current_user.id, post_id, comment.id)
        return ok(201, "Comment added successfully", comment=serialize(schemas.BlogCommentOut, comment))
    except NotFoundError as e:
        logger.warning("Create blog comment failed | post_id=%s reason=%s", post_id, e)
        return err(404, str(e))
    except Exception:
        logger.error("Create blog comment crashed | user_id=%s post_id=%s", current_user.id, post_id, exc_info=True)
        return err(500, "Internal server error")


@router.delete("/{post_id}/comments/{comment_id}")
def delete_comment(
    post_id: str,
    comment_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """A comment can be removed by whoever wrote it, or by the post's
    author moderating their own post's thread."""
    logger.info("Delete blog comment requested | user_id=%s post_id=%s comment_id=%s", current_user.id, post_id, comment_id)
    try:
        comment = (
            db.query(models.BlogComment)
            .filter(models.BlogComment.id == comment_id, models.BlogComment.post_id == post_id)
            .first()
        )
        if not comment:
            raise NotFoundError("Comment not found")

        post = db.query(models.BlogPost).filter(models.BlogPost.id == post_id).first()
        is_comment_author = comment.author_id == current_user.id
        is_post_author = post and post.author_id == current_user.id
        if not (is_comment_author or is_post_author):
            raise ForbiddenError("You can't delete someone else's comment.")

        db.delete(comment)
        db.commit()
        logger.info("Delete blog comment succeeded | user_id=%s post_id=%s comment_id=%s", current_user.id, post_id, comment_id)
        return ok(200, "Comment deleted successfully")
    except NotFoundError as e:
        logger.warning("Delete blog comment failed | post_id=%s comment_id=%s reason=%s", post_id, comment_id, e)
        return err(404, str(e))
    except ForbiddenError as e:
        logger.warning(
            "Delete blog comment failed: user_id=%s not authorized | post_id=%s comment_id=%s",
            current_user.id, post_id, comment_id,
        )
        return err(403, str(e))
    except Exception:
        logger.error("Delete blog comment crashed | post_id=%s comment_id=%s", post_id, comment_id, exc_info=True)
        return err(500, "Internal server error")