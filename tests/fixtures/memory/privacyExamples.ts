export const FAKE_MEMORY_SECRETS = [
  'sk-ant-api03-' + 'test_only_fake_'.repeat(4),
  'AIza' + 'A'.repeat(35),
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LW9ubHkifQ.' + 'F'.repeat(43),
  '-----BEGIN RSA PRIVATE KEY-----\nTEST_ONLY_FAKE_BODY\n-----END RSA PRIVATE KEY-----',
  'Authorization: Basic TEST_ONLY_FAKE_AUTH',
  'https://admin:TEST_ONLY_fake_pw@internal.example.com/db',
  'github_pat_' + 'TEST_ONLY_FAKE_'.repeat(3),
  'aws_secret_access_key = ' + 'TESTonlyFAKE/'.repeat(3) + 'x'
] as const
