"""Browser transport and native image-to-video regression tests."""
import json
import unittest
from unittest.mock import AsyncMock, patch
from src.services.flow_client import FlowClient

class VideoBrowserTransport(unittest.IsolatedAsyncioTestCase):
 def setUp(self):
  p=patch('src.services.flow_client.config');self.config=p.start();self.addCleanup(p.stop)
  self.config.captcha_method='extension';self.config.flow_max_retries=1
  self.config.flow_api_base_url='https://aisandbox-pa.googleapis.com/v1';self.config.flow_timeout=120
 def service(self,result):
  service=AsyncMock();service.submit_flow_request.return_value={'status':200,'text':json.dumps(result)}
  return service
 async def test_video_submit_uses_mapped_browser_instead_of_stale_access_token(self):
  client=FlowClient(None);client._make_request=AsyncMock(side_effect=AssertionError('must not submit directly'))
  service=self.service({'operations':[]})
  with patch('src.services.browser_captcha_extension.ExtensionCaptchaService.get_instance',AsyncMock(return_value=service)):
   await client._make_video_api_request(url='https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage',json_data={'requests':[]},at='stale-token',timeout=90,project_id='p1',token_id=5)
  sent=service.submit_flow_request.await_args.kwargs
  self.assertEqual(sent['token_id'],5);self.assertEqual(sent['project_id'],'p1');self.assertEqual(sent['action'],'VIDEO_GENERATION')
  client._make_request.assert_not_awaited()
 async def test_video_reference_upload_returns_real_media_id(self):
  client=FlowClient(None);client._make_request=AsyncMock(side_effect=AssertionError('no direct upload'))
  service=self.service({'media':{'name':'real-media-id'}})
  with patch('src.services.browser_captcha_extension.ExtensionCaptchaService.get_instance',AsyncMock(return_value=service)):
   media=await client.upload_image('stale-token',b'\xff\xd8\xff'+b'0'*16,project_id='p1',token_id=5,defer_to_image_ui=False)
  self.assertEqual(media,'real-media-id');self.assertFalse(client._staged_ui_uploads)
  sent=service.submit_flow_request.await_args.kwargs
  self.assertEqual(sent['action'],'UPLOAD_IMAGE');self.assertEqual(sent['token_id'],5)
 async def test_native_video_carries_reference_and_reuses_completed_browser_result(self):
  client=FlowClient(None)
  client._remember_uploaded_media_file_name('ref-id','product.jpg')
  client._stage_ui_upload('ref-id','product.jpg','image/jpeg','cmVm')
  result={'flow2apiTransport':'flow_google_video_ui','media':[{'name':'video-id','status':'MEDIA_GENERATION_STATUS_SUCCESSFUL','video':{'generatedVideo':{'encodedVideo':'bXA0','aspectRatio':'VIDEO_ASPECT_RATIO_PORTRAIT','duration':'8s'}}}]}
  service=self.service(result)
  with patch('src.services.browser_captcha_extension.ExtensionCaptchaService.get_instance',AsyncMock(return_value=service)):
   generated=await client._make_video_api_request(url='https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage',json_data={'requests':[{'startImage':{'mediaId':'ref-id'}}]},at='stale-token',timeout=90,project_id='p1',token_id=5)
   polled=await client.check_video_status('stale-token',generated['operations'],project_id='p1',token_id=5)
  sent=service.submit_flow_request.await_args.kwargs
  self.assertEqual(sent['json_data']['__flow2apiUiContext']['inputUploads'][0]['imageBytes'],'cmVm')
  self.assertEqual(polled['operations'][0]['operation']['metadata']['video']['encodedVideo'],'bXA0')
  self.assertEqual(service.submit_flow_request.await_count,1)
  self.assertNotIn('ref-id',client._staged_ui_uploads)
 async def test_poll_keeps_originating_browser_and_project(self):
  client=FlowClient(None)
  client._operations_to_media_refs=lambda _: [{'name':'m1','projectId':'p1'}]
  client._make_video_api_request=AsyncMock(return_value={'operations':[]})
  await client.check_video_status('stale-token',[],project_id='p1',token_id=5)
  sent=client._make_video_api_request.await_args.kwargs
  self.assertEqual(sent['project_id'],'p1');self.assertEqual(sent['token_id'],5)
 async def test_captcha_route_error_keeps_its_actionable_error_code(self):
  from src.services.browser_captcha_extension import ExtensionCaptchaError
  client=FlowClient(None)
  service=AsyncMock()
  service.get_token_bundle.side_effect=ExtensionCaptchaError('route unavailable',code='extension_route_unavailable')
  with patch('src.services.browser_captcha_extension.ExtensionCaptchaService.get_instance',AsyncMock(return_value=service)):
   with self.assertRaises(ExtensionCaptchaError) as caught:
    await client._get_recaptcha_token('p1','VIDEO_GENERATION',token_id=5)
  self.assertEqual(caught.exception.code,'extension_route_unavailable')
 async def test_native_policy_failure_is_terminal_without_browser_recycling(self):
  client=FlowClient(None);client._notify_browser_captcha_error=AsyncMock()
  retry=await client._handle_retryable_generation_error(Exception('HTTP Error 502: Flow content policy rejected the video request (safety filters)'),retry_attempt=0,max_retries=3,browser_id=None,project_id='p1',log_prefix='test')
  self.assertFalse(retry)
  client._notify_browser_captcha_error.assert_not_awaited()
 async def test_missing_browser_route_cannot_fall_back_to_direct_auth(self):
  client=FlowClient(None)
  with self.assertRaisesRegex(ValueError,'originating project'):
   await client._make_video_api_request(url='https://aisandbox-pa.googleapis.com/v1/video:test',json_data={},at='stale-token',timeout=20)

class NativeVideoResultTests(unittest.IsolatedAsyncioTestCase):
 async def test_native_mp4_is_cached_without_legacy_authenticated_redirect(self):
  import base64
  from types import SimpleNamespace
  from src.services.generation_handler import GenerationHandler
  handler=GenerationHandler.__new__(GenerationHandler)
  handler.flow_client=AsyncMock()
  handler.file_cache=AsyncMock()
  handler.file_cache.cache_base64_video.return_value='native.mp4'
  handler._get_base_url=lambda: 'http://localhost:38000'
  encoded=base64.b64encode(b'\x00\x00\x00\x14ftypisom').decode()
  operation={'mediaName':'video-id','operation':{'metadata':{'video':{'encodedVideo':encoded,'duration':'8s'}}}}
  result=await handler._resolve_video_asset(SimpleNamespace(st='legacy-session'),operation)
  self.assertEqual(result['video_url'],'http://localhost:38000/tmp/native.mp4')
  handler.flow_client.get_media_url_redirect.assert_not_awaited()
  self.assertNotIn('encodedVideo',result['video_info'])
 async def test_old_extensions_have_actionable_reload_error(self):
  from src.services.browser_captcha_extension import ExtensionCaptchaService, ExtensionCaptchaError
  for version in ('1.3.13', '1.3.19', '1.3.20', '', 'malformed'):
   with self.assertRaises(ExtensionCaptchaError) as caught:
    ExtensionCaptchaService._require_video_ui_version(version)
   self.assertEqual(caught.exception.code,'extension_reload_required')
  ExtensionCaptchaService._require_video_ui_version('1.3.21')
  ExtensionCaptchaService._require_video_ui_version('1.4')

class VideoBrowserSelectionTests(unittest.IsolatedAsyncioTestCase):
 async def test_video_skips_old_extension_without_disabling_image_route(self):
  from types import SimpleNamespace
  from src.services.load_balancer import LoadBalancer
  from src.services.browser_captcha_extension import ExtensionCaptchaService
  service=SimpleNamespace(
   has_connection_for_token=AsyncMock(return_value=(True,'google-a')),
   get_runtime_status=lambda: {'routes':[{'route_key':'google-a','extension_version':'1.3.13'}]},
   _require_video_ui_version=ExtensionCaptchaService._require_video_ui_version,
  )
  balancer=LoadBalancer(SimpleNamespace(db=None))
  with patch('src.services.load_balancer.config') as config, patch('src.services.browser_captcha_extension.ExtensionCaptchaService.get_instance',AsyncMock(return_value=service)):
   config.captcha_method='extension'
   self.assertFalse((await balancer._check_extension_route(SimpleNamespace(id=1),require_video_ui=True))[0])
   self.assertTrue((await balancer._check_extension_route(SimpleNamespace(id=1)))[0])
   service.get_runtime_status=lambda: {'routes':[{'route_key':'google-a','extension_version':'1.3.21'}]}
   self.assertTrue((await balancer._check_extension_route(SimpleNamespace(id=1),require_video_ui=True))[0])

class NativeVideoUploadTimeoutTests(unittest.IsolatedAsyncioTestCase):
 async def test_native_upload_can_outlast_30s_heartbeat_without_disabling_hard_limit(self):
  import asyncio
  from src.services.browser_captcha_extension import ExtensionCaptchaService
  service=ExtensionCaptchaService(None)
  service._pending_flow_activity['r1']=(100,'ui_preparing')
  result={'status':'success'}
  future=asyncio.get_running_loop().create_future()
  future.set_result(result)
  with patch('src.services.browser_captcha_extension.config') as config, patch('src.services.browser_captcha_extension.time') as clock:
   clock.monotonic.side_effect=[100,140]
   config.extension_progress_stall_timeout_seconds=30
   actual=await service._wait_for_flow_submit_result(future=future,req_id='r1',timeout=300,supports_progress=True,preparation_timeout=90)
  self.assertEqual(actual,result)

 async def test_image_phase_heartbeat_does_not_hide_a_stuck_flow_page(self):
  import asyncio
  from src.services.browser_captcha_extension import ExtensionCaptchaService, ExtensionCaptchaError
  service=ExtensionCaptchaService(None)
  service._pending_flow_activity['r1']=(100,'generating',100)
  future=asyncio.get_running_loop().create_future()
  with patch('src.services.browser_captcha_extension.config') as config, patch('src.services.browser_captcha_extension.time') as clock:
   clock.monotonic.side_effect=[221,221]
   config.extension_progress_stall_timeout_seconds=30
   with self.assertRaises(ExtensionCaptchaError) as caught:
    await service._wait_for_flow_submit_result(future=future,req_id='r1',timeout=180,supports_progress=True,max_phase_duration=120)
  self.assertEqual(caught.exception.code,'extension_flow_stalled')

 async def test_image_waiting_for_result_uses_shorter_phase_limit(self):
  import asyncio
  from src.services.browser_captcha_extension import ExtensionCaptchaService, ExtensionCaptchaError
  service=ExtensionCaptchaService(None)
  service._pending_flow_activity['r1']=(100,'waiting_for_result',100)
  future=asyncio.get_running_loop().create_future()
  with patch('src.services.browser_captcha_extension.config') as config, patch('src.services.browser_captcha_extension.time') as clock:
   clock.monotonic.side_effect=[131,131]
   config.extension_progress_stall_timeout_seconds=60
   config.extension_image_result_timeout_seconds=30
   with self.assertRaises(ExtensionCaptchaError) as caught:
    await service._wait_for_flow_submit_result(future=future,req_id='r1',timeout=180,supports_progress=True,max_phase_duration=95)
  self.assertEqual(caught.exception.code,'extension_flow_stalled')
  self.assertIn('30.0s',str(caught.exception))

class VideoOnboardingTests(unittest.TestCase):
 def test_onboarding_is_reported_without_accepting_or_blocking_image_connections(self):
  from src.services.browser_captcha_extension import ExtensionCaptchaService, ExtensionCaptchaError
  service=ExtensionCaptchaService(None)
  response=json.dumps({'error':{'message':'Timed out; UI: '+json.dumps({'buttons':['동의함','나중에']})}})
  with self.assertRaises(ExtensionCaptchaError) as caught:
   service._check_video_ui_result('google-h',response)
  self.assertEqual(caught.exception.code,'extension_user_action_required')
  self.assertIn('google-h',service._video_ui_blocked_routes)
  self.assertNotIn('google-h',service._disabled_route_keys)
  service._check_video_ui_result('google-a',json.dumps({'error':{'message':'ordinary failure'}}))
  self.assertNotIn('google-a',service._video_ui_blocked_routes)

class VideoImageRightsTests(unittest.TestCase):
 def test_image_rights_dialog_is_actionable_and_does_not_disable_account(self):
  from src.services.browser_captcha_extension import ExtensionCaptchaService, ExtensionCaptchaError
  service=ExtensionCaptchaService(None)
  response=json.dumps({'error':{'message':'Timed out; UI: '+json.dumps({'dialogs':['이 이미지를 사용할 권리 필요한 권리를 보유하고 있는지 확인하세요.'],'buttons':['취소','동의']})}})
  with self.assertRaises(ExtensionCaptchaError) as caught:
   service._check_video_ui_result('google-d',response)
  self.assertEqual(caught.exception.code,'extension_image_rights_confirmation_required')
  self.assertEqual(service._video_ui_blocked_routes,{})
  self.assertEqual(service._disabled_route_keys,set())

class ImageConsentScopeTests(unittest.TestCase):
 def test_only_explicitly_approved_image_bytes_carry_consent(self):
  import base64, hashlib, tempfile
  from pathlib import Path
  with tempfile.TemporaryDirectory() as folder:
   client=FlowClient(None)
   client._image_rights_path=Path(folder)/'consents.json'
   photo=b'approved product photo'
   client._image_rights_path.write_text(json.dumps({'version':1,'images':[{'sha256':hashlib.sha256(photo).hexdigest(),'allowed':True}]}))
   client._stage_ui_upload('approved','product.jpg','image/jpeg',base64.b64encode(photo).decode())
   client._stage_ui_upload('other','other.jpg','image/jpeg',base64.b64encode(b'other photo').decode())
   self.assertIs(client._staged_ui_uploads['approved']['rightsConfirmed'],True)
   self.assertNotIn('rightsConfirmed',client._staged_ui_uploads['other'])
   client._image_rights_path.write_text('{broken')
   self.assertFalse(client._has_image_rights_consent(base64.b64encode(photo).decode()))
