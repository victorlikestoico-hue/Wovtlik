# 🤖 Agente WhatsApp Local Multimodal con DeepSeek

Este es un agente de WhatsApp local de nivel empresarial estructurado bajo **Clean/Hexagonal Architecture** y **Spec-Driven Development (SDD)**. Utiliza la librería `@whiskeysockets/baileys` para conectarse a un número real escaneando un código QR y delega el procesamiento inteligente a la API oficial de **DeepSeek Chat**.

---

## 🛠️ Stack Tecnológico

- **Core**: Next.js 15+ (App Router) + TypeScript + React 19 (con Turbopack).
- **Styling**: Tailwind CSS v4 Vanilla (diseño minimalista de alta gama, micro-interacciones responsivas).
- **WhatsApp Web API**: `@whiskeysockets/baileys` v6.7+ (conexión estable a nivel protocolo, sin APIs oficiales costosas).
- **Base de Datos**: PostgreSQL (`pg` node-postgres para persistencia robusta de conversaciones, mensajes y configuración).
- **Caché y Turnos**: Redis (`ioredis` para locks distribuidos, deduplicación de eventos y debouncing).
- **Notificaciones**: API de Telegram (Alertas en tiempo real al dueño del bot).
- **Orquestación**: Docker & Docker Compose.

---

## 💡 Características Principales

1. **Autenticación Integrada**: Dashboard protegido mediante credenciales de administrador (variables de entorno `ADMIN_EMAIL` y `ADMIN_PASSWORD`) gestionadas mediante cookies HTTP-Only.
2. **Gestión de Turnos y Lock Concurrente**: Redis controla atómicamente que el bot no procese mensajes duplicados ni colisione con intervenciones manuales del operador humano.
3. **Control por Palabras Clave del Dueño (Owner Control)**: Envía desde tu WhatsApp personal palabras clave configuradas como `bot off` (para pasar a modo `HUMAN` y suspender la IA) u `ok.` (para reactivar el modo `AI`).
4. **Reactivación Automática tras Inactividad**: Si un operador humano interviene en una conversación y esta permanece inactiva por más de 3 días, el bot se reactivará automáticamente a modo `AI`.
5. **Respuestas Humanizadas Segmentadas**: La IA responde en partes, aplicando retrasos inteligentes proporcionales a la longitud del texto para simular la escritura de un ser humano.
6. **Detección Automática de Handoff**: DeepSeek analiza la conversación y delega el chat a atención humana si detecta frustración, preguntas fuera del alcance, intenciones de compra o solicitud explícita de un asesor, notificando inmediatamente al dueño por Telegram.
7. **Seguimientos Programados (Follow-Ups)**: Tarea cron periódica inteligente que evalúa usuarios inactivos en modo `AI` tras el último mensaje de la IA, aplicando controles estrictos (evita enviar mensajes free-form fuera de la ventana de 24 horas para cumplir las políticas de WhatsApp).
8. **CRUD de System Prompts**: Dashboard visual para alternar en tiempo real qué prompt del sistema guiará a la IA.

---

## 🚀 Guía de Arranque Rápido con Docker Compose

La forma recomendada de desplegar el proyecto es usando **Docker Compose**, ya que levanta la aplicación Next.js, el proceso bot, la base de datos PostgreSQL y la caché Redis de forma integrada.

### 1. Requisitos Previos

- Tener instalado **Docker** y **Docker Compose**.
- Contar con una cuenta de **DeepSeek** con créditos cargados (las cuentas gratuitas están limitadas por velocidad y darán errores `429 Too Many Requests`).

### 2. Configurar Variables de Entorno

Creá un archivo `.env.local` en la raíz del proyecto basándote en `.env.example`:

```bash
DEEPSEEK_API_KEY=tu-api-key-de-deepseek
DEEPSEEK_MODEL=deepseek-chat
DATABASE_URL=postgresql://user:password@db:5432/whatsapp_bot
REDIS_URL=redis://redis:6379
TELEGRAM_BOT_TOKEN=tu-bot-token-de-telegram # Opcional
TELEGRAM_CHAT_ID=tu-chat-id-de-telegram # Opcional
ADMIN_EMAIL=tu-email-de-admin
ADMIN_PASSWORD=tu-contrasena-segura
```

### 3. Levantar la Aplicación

Corré el siguiente comando en tu terminal:

```bash
docker-compose up -d --build
```

Esto descargará las imágenes oficiales, compilará la aplicación Next.js y levantará los servicios. Podrás acceder al dashboard en `http://localhost:3000`.

### Persistencia de WhatsApp en deploy

La sesión de WhatsApp se guarda con Baileys en el directorio configurado por `WHATSAPP_AUTH_DIR` (`/app/auth` en Docker). Ese directorio **es intencionalmente efímero** (no está en un volumen): cada redeploy/recreate del contenedor `app` pide un nuevo QR.

Esto es deliberado: si `/app/auth` se persiste en un volumen, un solape entre el contenedor viejo (terminando) y el nuevo (arrancando) durante el redeploy hace que dos procesos de Baileys se autentiquen con la misma identidad de dispositivo al mismo tiempo, lo cual WhatsApp interpreta como un dispositivo clonado y cierra **todas** las sesiones vinculadas de la cuenta (no solo el bot). Mantener `/app/auth` sin persistir hace ese conflicto imposible, a costa de tener que reescanear el QR después de cada deploy.

`bot_data` y `whatsapp_media` sí siguen en volúmenes nombrados (no contienen credenciales de sesión, así que no tienen este riesgo):

```yaml
bot_data:/app/data
whatsapp_media:/app/public/media
```

No borres esos volúmenes salvo que quieras perder datos/medios del bot. El botón de desconexión del dashboard es destructivo por diseño: elimina la sesión y fuerza un nuevo QR.

---

## 💻 Desarrollo Local (Sin Docker)

Si preferís correr la aplicación localmente paso a paso para depuración:

1. **Instalar Dependencias**:
   ```bash
   npm install
   ```
2. **Iniciar base de datos PostgreSQL y Redis** en tu máquina (y actualizar sus URLs en `.env.local`).
3. **Correr en modo desarrollo**:
   ```bash
   npm run dev
   ```
   Esto levantará el dashboard Next.js.
4. **Correr el proceso del bot de WhatsApp**:
   ```bash
   npm run start:bot
   ```
5. **Correr todo junto en modo producción**:
   ```bash
   npm run start:all
   ```

---

## ⚙️ Personalización del System Prompt Inicial

El comportamiento de la inteligencia artificial puede configurarse de dos formas:

1. **A través de la base de datos**: En la pestaña **System Prompts** del dashboard podés crear, editar y activar nuevos perfiles en tiempo real sin reiniciar el bot.
2. **Archivo Físico Fallback**: Si la base de datos no tiene prompts cargados, usará el prompt configurado por defecto en `src/lib/system-prompt.ts`. Podés personalizar esta plantilla modificando directamente dicho archivo.

---

## 🛡️ Seguridad

A diferencia de versiones anteriores, este proyecto ya cuenta con **autenticación nativa integrada**. Sin embargo, en entornos de producción se recomienda estrictamente el uso de HTTPS (mediante un proxy inverso como Nginx, Caddy o servicios de CDN como Cloudflare) para proteger la transmisión de credenciales y cookies de sesión.

---

## 🤝 Código Abierto y Contribución

Este proyecto es Open Source bajo la **Licencia MIT**. Nos encanta recibir ayuda de la comunidad. 

Si deseas colaborar, reportar fallos o proponer nuevas funcionalidades, por favor revisa nuestras guías:

* [Guía de Contribución](CONTRIBUTING.md): Pasos para hacer un fork, crear PRs y pautas de código.
* [Política de Seguridad](SECURITY.md): Procedimiento para reportar vulnerabilidades de manera segura.
* [Licencia](LICENSE): Condiciones de uso del proyecto.

---

## 🧪 Pruebas Unitarias e Integración

Contamos con una suite de tests robusta y deterministicos escritos sobre el test runner nativo de Node.js. Para correr la suite completa de tests ejecutá:

```bash
npm test
```

Para validar la correcta tipificación de TypeScript en todo el proyecto:

```bash
npx tsc --noEmit
```

---

## ❓ Preguntas Frecuentes (FAQ)

### 1. ¿Qué pasa con los mensajes de seguimiento (follow-ups) si el cliente no responde? ¿Se descartan al llegar al límite de intentos?
**Sí.** Una vez que se alcanza el límite máximo de intentos de seguimiento configurado en la base de datos (por ejemplo, 3 intentos), el bot descarta automáticamente el número. No se vuelve a leer su historial ni a realizar peticiones a la API de DeepSeek para esa conversación. El contador se restablece a 0 de forma automática únicamente cuando el cliente envía un nuevo mensaje, volviendo a ser elegible para seguimientos si el bot responde y el cliente vuelve a guardar silencio.

### 2. ¿Los seguimientos automáticos pueden chocar si el bot o el operador humano están chateando activamente con el cliente?
**No, no chocan.** Se utiliza un sistema de estado de turno y cerrojos distribuidos (locks) en Redis. Antes de procesar cualquier seguimiento, el planificador consulta el estado de la conversación. Si hay mensajes en cola (`turnQueue`), un retraso de escritura activo (`debounceMarker`), un procesamiento de respuesta de la IA en curso (`turnLock`), o el bot está mandando un mensaje (`processingMarker`), el planificador omite la evaluación inmediatamente.

### 3. ¿Qué ocurre si un operador humano interviene en una conversación? ¿Sigue funcionando el bot y el seguimiento?
**El bot se apaga completamente para ese chat.** Al intervenir un operador humano (ya sea escribiendo directamente desde WhatsApp o a través del panel web), el sistema detecta la respuesta de rol `human` y cambia de inmediato el modo de la conversación a `HUMAN`. En este modo, el bot no genera respuestas automáticas a mensajes entrantes ni el planificador de seguimientos procesa el número. Para reactivarlo, el operador debe cambiar el modo de la conversación a `AI` desde el dashboard o enviar la palabra clave de activación (ej: `ok.`) desde su WhatsApp en ese chat.

### 4. ¿Cómo se previene que el bot envíe el mismo mensaje de seguimiento exacto múltiples veces seguidas?
Se aplican dos capas de seguridad concurrentes:
- **Protección a Nivel Prompt (DeepSeek)**: El system prompt de seguimientos prohíbe repetir mensajes de seguimiento que ya aparezcan en el historial, forzando a la IA a cambiar de enfoque (por ejemplo, ofrecer una demo gratis de 3 días, preguntar por precios de planes o consultar por el equipo físico) en lugar de insistir con el mismo texto.
- **Guardia de Duplicados Programática**: El planificador limpia y normaliza el mensaje generado (eliminando acentos, mayúsculas, espacios y caracteres especiales) y lo compara con todos los mensajes salientes previos del asistente. Si detecta una repetición literal, bloquea el envío, registra un evento de omisión por duplicado y no satura al cliente.
