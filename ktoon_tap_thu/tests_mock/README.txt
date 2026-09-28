Offline test kit from the v1 episode app (built and passing 2026-09-28).
- mock_providers.py: fake WaveSpeed (media, LLM, balance) + Atlas (video, balance). Keys: test-ws-key-123456 / test-atlas-key-123456.
  Serves files/ as generated media. Fails the first lip-sync job on purpose. Charges balances so price probes can be tested
  (Seedance 2.5 is charged $0.30/s here to simulate a real price above the listed $0.134).
- run_env.sh: starts the mocks + a copy of ../ktoon_tap_thu/app.py with env overrides (KTOON_* variables).
- e2e_v1.py: Playwright click-through of all 7 v1 steps (python3 e2e_v1.py after run_env.sh). Screenshots go to shots/.
For v2: extend the mocks for Seedance reference-to-video, uploadMedia, return_last_frame and Nano Banana Pro edit.
