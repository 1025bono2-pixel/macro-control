const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const {
  WebSocketServer,
  WebSocket
} = require('ws');

const PORT =
  Number(
    process.env.PORT ||
    10000
  );

const HOST_SECRET =
  String(
    process.env.HOST_SECRET ||
    ''
  );

const app =
  express();

const server =
  http.createServer(app);

const wss =
  new WebSocketServer({
    server,
    path: '/host'
  });

let host =
  null;

const pending =
  new Map();


function send(
  ws,
  data
) {
  if (
    ws &&
    ws.readyState ===
      WebSocket.OPEN
  ) {
    ws.send(
      JSON.stringify(data)
    );

    return true;
  }

  return false;
}


function callHost(
  payload,
  timeout = 30000
) {
  return new Promise(
    (
      resolve,
      reject
    ) => {

      if (
        !host ||
        host.readyState !==
          WebSocket.OPEN
      ) {
        reject(
          new Error(
            '총괄 PC Host가 오프라인입니다.'
          )
        );

        return;
      }

      const requestId =
        crypto.randomUUID();

      const timer =
        setTimeout(
          () => {
            pending.delete(
              requestId
            );

            reject(
              new Error(
                'Host 응답 시간 초과'
              )
            );
          },
          timeout
        );

      pending.set(
        requestId,
        {
          resolve,
          reject,
          timer
        }
      );

      send(
        host,
        {
          type:
            'proxy.http',

          requestId,

          payload
        }
      );
    }
  );
}


wss.on(
  'connection',
  (
    ws,
    req
  ) => {

    console.log(
      '[HOST] WebSocket connection received'
    );

    const url =
      new URL(
        req.url,
        'http://localhost'
      );

    const receivedSecret =
      String(
        url.searchParams.get(
          'secret'
        ) || ''
      );

    if (
      !HOST_SECRET
    ) {
      console.log(
        '[HOST] HOST_SECRET is not configured'
      );

      ws.close(
        1008,
        'server secret missing'
      );

      return;
    }

    if (
      receivedSecret !==
      HOST_SECRET
    ) {
      console.log(
        '[HOST] authentication failed'
      );

      ws.close(
        1008,
        'unauthorized'
      );

      return;
    }

    console.log(
      '[HOST] authentication successful'
    );

    if (
      host &&
      host.readyState ===
        WebSocket.OPEN
    ) {
      console.log(
        '[HOST] replacing previous Host'
      );

      host.close(
        1012,
        'replaced'
      );
    }

    host =
      ws;

    console.log(
      '[HOST] connected'
    );


    ws.on(
      'message',
      raw => {

        let message;

        try {
          message =
            JSON.parse(
              String(raw)
            );
        } catch {
          return;
        }

        if (
          message.requestId &&
          pending.has(
            message.requestId
          )
        ) {

          const item =
            pending.get(
              message.requestId
            );

          pending.delete(
            message.requestId
          );

          clearTimeout(
            item.timer
          );

          if (
            message.ok ===
            false
          ) {
            item.reject(
              new Error(
                message.error ||
                'Host error'
              )
            );
          } else {
            item.resolve(
              message.result
            );
          }
        }
      }
    );


    ws.on(
      'pong',
      () => {
        ws.isAlive =
          true;
      }
    );


    ws.on(
      'error',
      error => {
        console.log(
          '[HOST] WebSocket error:',
          error.message
        );
      }
    );


    ws.on(
      'close',
      (
        code,
        reason
      ) => {

        console.log(
          '[HOST] disconnected',
          'code=' + code,
          'reason=' +
            String(
              reason || ''
            )
        );

        if (
          host ===
          ws
        ) {
          host =
            null;
        }
      }
    );

    ws.isAlive =
      true;
  }
);


const heartbeat =
  setInterval(
    () => {

      wss.clients.forEach(
        ws => {

          if (
            ws.isAlive ===
            false
          ) {
            console.log(
              '[HOST] heartbeat timeout'
            );

            ws.terminate();

            return;
          }

          ws.isAlive =
            false;

          try {
            ws.ping();
          } catch {}
        }
      );
    },
    30000
  );


wss.on(
  'close',
  () => {
    clearInterval(
      heartbeat
    );
  }
);


app.get(
  '/health',
  (
    req,
    res
  ) => {

    res.json({
      ok: true,

      hostConnected:
        !!(
          host &&
          host.readyState ===
            WebSocket.OPEN
        )
    });
  }
);


app.use(
  '/api',
  (
    req,
    res
  ) => {

    const chunks =
      [];

    let size =
      0;

    req.on(
      'data',
      chunk => {

        size +=
          chunk.length;

        if (
          size >
          25 *
          1024 *
          1024
        ) {
          req.destroy();

          return;
        }

        chunks.push(
          chunk
        );
      }
    );


    req.on(
      'end',
      async () => {

        try {

          const body =
            Buffer.concat(
              chunks
            );

          const result =
            await callHost({
              method:
                req.method,

              path:
                req.originalUrl,

              headers:
                req.headers,

              bodyBase64:
                body.toString(
                  'base64'
                )
            });


          const headers =
            result.headers ||
            {};


          for (
            const [
              key,
              value
            ]
            of Object.entries(
              headers
            )
          ) {

            if (
              value ===
              undefined
            ) {
              continue;
            }

            if (
              [
                'connection',
                'transfer-encoding',
                'content-length'
              ].includes(
                key.toLowerCase()
              )
            ) {
              continue;
            }

            try {
              res.setHeader(
                key,
                value
              );
            } catch {}
          }


          const output =
            Buffer.from(
              result.bodyBase64 ||
              '',
              'base64'
            );


          res
            .status(
              result.status ||
              500
            )
            .send(
              output
            );

        } catch (
          error
        ) {

          res
            .status(503)
            .json({
              error:
                error.message
            });
        }
      }
    );
  }
);


app.use(
  express.static(
    path.join(
      __dirname,
      '..',
      'public'
    )
  )
);


app.get(
  '/*splat',
  (
    req,
    res
  ) => {

    res.sendFile(
      path.join(
        __dirname,
        '..',
        'public',
        'index.html'
      )
    );
  }
);


server.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      '[MACRO CONTROL] ' +
      PORT
    );
  }
);
