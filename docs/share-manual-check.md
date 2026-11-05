# Share client manual check (darkpyonix#20)

Refs DarkPyonix/darkpyonix#20, SPEC FR-A2, FR-A3, FR-S9. Real browser, real dedicated manager.
Never paste the master token or a share token into logs, issues or screenshots.

## Setup
1. Start a dedicated manager and a kernel for a file with at least one cell that prints output; run the file once so there is history.
2. Print the master token (`darkpyonix` CLI, per FR-A4) and keep it local.
3. Create three shares with `POST /api/kernels/{kernel_id}/shares` (master token), bodies `{"capabilities":["read"]}`, `{"capabilities":["read","history"]}`, `{"capabilities":["read","history","execute"]}`. The token is shown once.

## Steps and expected results (per share token)
Open the ash page with `?manager=<manager url>&kernel=<kernel id>#<token>` (or the `/s/<share_id>#<token>` link when the hub resolves it).

| Share | `GET .../tokens/<token>/verify` | `GET .../document` | `GET .../runs` | `POST .../runs` | WS `request_history` | WS `start_typing` |
|---|---|---|---|---|---|---|
| read | `["read"]` | 200, cells without outputs | 403 | 403 | empty `history` | `error: INSUFFICIENT_PERMISSION` |
| read+history | `["read","history"]` | 200, cells with outputs | 200 | 403 | entries present | `INSUFFICIENT_PERMISSION` |
| read+history+execute | adds `execute` | 200 with outputs | 200 | 202 | entries present | `INSUFFICIENT_PERMISSION` |

Also check for every share: `POST .../cells` and `PUT .../cells/<id>/lock` answer 403 (no `edit`); the address bar no longer shows the token after load; the browser console and network log show no token in any message other than the request itself.

A share for a different kernel answers 404, never 403. Revoking a share closes its open WebSocket.
