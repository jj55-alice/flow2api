"""Explicit consent for exact reference bytes, limited to one API request."""
import base64
import contextvars
import hashlib
import re
from contextlib import contextmanager

_approved_images = contextvars.ContextVar("flow_image_rights", default=frozenset())

def validate_image_rights_consents(digests, images):
    if len(digests) > 16 or any(not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value) for value in digests):
        raise ValueError("imageRightsConsents must contain at most 16 SHA-256 image hashes")
    supplied = {hashlib.sha256(image).hexdigest() for image in images}
    if not set(digests).issubset(supplied):
        raise ValueError("imageRightsConsents must match the exact reference images in this request")
    return tuple(dict.fromkeys(digests))

@contextmanager
def image_rights_scope(digests):
    marker = _approved_images.set(frozenset(digests))
    try:
        yield
    finally:
        _approved_images.reset(marker)

def has_request_image_consent(image_base64):
    try:
        digest = hashlib.sha256(base64.b64decode(image_base64, validate=True)).hexdigest()
        return digest in _approved_images.get()
    except (ValueError, TypeError):
        return False
