import json
import unittest
from unittest.mock import AsyncMock
from src.services.browser_captcha_extension import ExtensionCaptchaService, ExtensionCaptchaError
from src.services.flow_client import FlowClient
from src.services.generation_handler import GenerationHandler


class FailureEvidenceTests(unittest.IsolatedAsyncioTestCase):
 async def test_final_failure_log_keeps_source_and_original_message(self):
  from types import SimpleNamespace
  error=ExtensionCaptchaError('Flow video audio generation failed',code='flow_video_audio_failed')
  error.http_status=502;error.source='flow_error_tile';error.upstream_message='오디오를 생성할 수 없습니다.'
  handler=GenerationHandler.__new__(GenerationHandler)
  handler.flow_client=SimpleNamespace(clear_request_fingerprint=lambda:None)
  token=SimpleNamespace(id=4,email='test@example.invalid')
  handler.load_balancer=SimpleNamespace(select_token=AsyncMock(return_value=token),release_pending=AsyncMock())
  handler.token_manager=SimpleNamespace(ensure_valid_token=AsyncMock(side_effect=error))
  handler._log_request=AsyncMock(return_value=7)
  handler._update_request_log_progress=AsyncMock()
  handler._record_token_failure=AsyncMock()
  chunks=[item async for item in handler.handle_generation('veo_3_1_t2v_fast_portrait','fixture',stream=True)]
  log=handler._log_request.await_args.args[3]
  self.assertEqual(log['error_source'],'flow_error_tile')
  self.assertEqual(log['upstream_message'],error.upstream_message)
  self.assertEqual(log['error_code'],'flow_video_audio_failed')
  self.assertEqual(json.loads(chunks[-1])['error']['code'],'flow_video_audio_failed')

 async def test_original_card_message_survives_transport_and_no_native_failure_is_retried(self):
  for code, source in [
   ('flow_video_audio_failed', 'flow_error_tile'),
   ('flow_video_generation_failed', 'flow_error_tile'),
   ('flow_video_policy_rejected', 'flow_error_tile'),
   ('flow_video_agent_reported_failure', 'flow_agent_text'),
  ]:
   service=ExtensionCaptchaService(None)
   message='오디오를 생성할 수 없습니다.' if code=='flow_video_audio_failed' else 'Original failure message'
   response=json.dumps({'error': {'code':code,'message':'Generation failed','source':source,'upstream_message':message}})
   with self.assertRaises(ExtensionCaptchaError) as caught:
    service._check_flow_ui_result('google-d',response)
   error=caught.exception
   self.assertEqual(error.source,source)
   self.assertEqual(error.upstream_message,message)
   handler=GenerationHandler.__new__(GenerationHandler)
   self.assertEqual(handler._classify_generation_error(error),(502,code))
   self.assertFalse(handler._should_count_token_error(error))
   self.assertEqual(service._video_ui_blocked_routes,{})
   client=FlowClient(None);client._notify_browser_captcha_error=AsyncMock()
   self.assertFalse(await client._handle_retryable_generation_error(error,0,3,None,'project','test'))
   client._notify_browser_captcha_error.assert_not_awaited()

 def test_unknown_response_does_not_become_a_trusted_card_failure(self):
  service=ExtensionCaptchaService(None)
  service._check_flow_ui_result('google-d',json.dumps({'error':{'code':'flow_video_policy_rejected','source':'other','message':'safety filters'}}))
