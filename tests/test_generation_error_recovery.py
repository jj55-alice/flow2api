import unittest

from src.services.flow_client import FlowClient
from src.services.generation_handler import GenerationHandler


class GenerationErrorRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.handler = object.__new__(GenerationHandler)
        self.client = FlowClient(proxy_manager=None)

    def test_policy_rejection_does_not_count_as_account_error_or_retry(self):
        error = "PUBLIC_ERROR_UNSAFE_GENERATION: Request contains an invalid argument."

        self.assertFalse(self.handler._should_count_token_error(error))
        self.assertIsNone(self.client._get_retry_reason(error))

    def test_missing_browser_response_retries_without_counting_account_error(self):
        error = "Flow browser submit returned no HTTP response"

        self.assertFalse(self.handler._should_count_token_error(error))
        self.assertEqual(self.client._get_retry_reason(error), "网络/TLS错误")

    def test_authentication_failure_still_counts_as_account_error(self):
        self.assertTrue(
            self.handler._should_count_token_error("HTTP 401 UNAUTHENTICATED")
        )


if __name__ == "__main__":
    unittest.main()
