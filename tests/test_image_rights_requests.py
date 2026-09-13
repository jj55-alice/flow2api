import asyncio
import base64
import hashlib
import json
import unittest
from unittest.mock import patch
from fastapi import HTTPException
from src.core.image_rights import image_rights_scope, has_request_image_consent, validate_image_rights_consents
from src.core.models import GeminiGenerateContentRequest
from src.services.flow_client import FlowClient
from src.api import routes

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=")
DIGEST = hashlib.sha256(PNG).hexdigest()
ENCODED = base64.b64encode(PNG).decode()

def request(digests):
    return GeminiGenerateContentRequest(contents=[{"role":"user", "parts":[{"text":"draw a scene"},{"inlineData":{"mimeType":"image/png","data":ENCODED}}]}], imageRightsConsents=digests)

class ConsentTests(unittest.IsolatedAsyncioTestCase):
    def test_unapproved_images_remain_blocked(self):
        self.assertFalse(has_request_image_consent(ENCODED))
        client = FlowClient(None)
        with patch.object(client, '_image_rights_path') as path:
            path.open.side_effect = FileNotFoundError
            with image_rights_scope([DIGEST]):
                client._stage_ui_upload('yes', 'one.png', 'image/png', ENCODED)
                client._stage_ui_upload('no', 'two.png', 'image/png', base64.b64encode(b'other').decode())
            client._stage_ui_upload('later', 'one.png', 'image/png', ENCODED)
        self.assertTrue(client._staged_ui_uploads['yes']['rightsConfirmed'])
        self.assertNotIn('rightsConfirmed', client._staged_ui_uploads['no'])
        self.assertNotIn('rightsConfirmed', client._staged_ui_uploads['later'])

    def test_server_wide_consent_requires_explicit_manifest_opt_in(self):
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as folder:
            client = FlowClient(None)
            client._image_rights_path = Path(folder) / 'consents.json'
            client._image_rights_path.write_text(json.dumps({
                'version': 1,
                'allowAll': True,
                'images': [],
            }))
            client._stage_ui_upload('new', 'new.png', 'image/png', ENCODED)
            self.assertTrue(client._staged_ui_uploads['new']['rightsConfirmed'])
            self.assertFalse(client._has_image_rights_consent('not-base64'))

            client._image_rights_path.write_text(json.dumps({
                'version': 1,
                'allowAll': False,
                'images': [],
            }))
            self.assertFalse(client._has_image_rights_consent(ENCODED))

    async def test_parallel_requests_do_not_share_consent(self):
        async def check(allowed):
            with image_rights_scope([DIGEST] if allowed else []):
                await asyncio.sleep(0)
                return has_request_image_consent(ENCODED)
        self.assertEqual(await asyncio.gather(check(True), check(False)), [True, False])
        self.assertFalse(has_request_image_consent(ENCODED))

    async def test_normalization_accepts_exact_hash_and_rejects_unrelated_hash(self):
        normalized = await routes._normalize_gemini_request('gemini-3.1-flash-image-three-four', request([DIGEST]))
        self.assertEqual(normalized.image_rights_consents, (DIGEST,))
        for digests in [['0'*64], ['invalid']]:
            with self.assertRaises(HTTPException) as error:
                await routes._normalize_gemini_request('gemini-3.1-flash-image-three-four', request(digests))
            self.assertEqual(error.exception.status_code, 400)

    async def test_handler_failure_clears_consent(self):
        class Handler:
            async def handle_generation(self, **kwargs):
                self.seen = has_request_image_consent(ENCODED)
                raise RuntimeError('test failure')
                yield
        handler = Handler()
        with patch.object(routes, 'generation_handler', handler):
            with self.assertRaises(RuntimeError):
                await routes._collect_non_stream_result('test', 'prompt', [PNG], image_rights_consents=(DIGEST,))
        self.assertTrue(handler.seen)
        self.assertFalse(has_request_image_consent(ENCODED))

    async def test_endpoint_propagates_scoped_consent_and_defaults_to_none(self):
        from starlette.requests import Request
        class Handler:
            async def handle_generation(self, **kwargs):
                self.seen = has_request_image_consent(ENCODED)
                yield json.dumps({'error': {'message':'stop before generation','status_code':400}})
        for digests in [[], [DIGEST]]:
            handler = Handler()
            raw = Request({'type':'http','method':'POST','path':'/','scheme':'http','server':('localhost',8000),'headers':[],'query_string':b''})
            with patch.object(routes, 'generation_handler', handler):
                await routes.generate_content('gemini-3.1-flash-image-three-four', request(digests), raw, 'test')
            self.assertEqual(handler.seen, bool(digests))
            self.assertFalse(has_request_image_consent(ENCODED))

    async def test_stream_closing_resets_consent(self):
        class Handler:
            async def handle_generation(self, **kwargs):
                self.seen = has_request_image_consent(ENCODED)
                yield json.dumps({'error': {'message':'stop','status_code':400}})
        handler = Handler()
        normalized = routes.NormalizedGenerationRequest('test', 'prompt', [PNG], image_rights_consents=(DIGEST,))
        with patch.object(routes, 'generation_handler', handler):
            iterator = routes._iterate_gemini_stream(normalized, 'test')
            await anext(iterator)
            await iterator.aclose()
        self.assertTrue(handler.seen)
        self.assertFalse(has_request_image_consent(ENCODED))

if __name__ == '__main__':
    unittest.main()
