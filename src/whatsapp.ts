import axios from "axios";
import {
	ConnectionOptions,
	FieldPacket,
	Pool,
	RowDataPacket,
	createPool,
} from "mysql2/promise";
import WAWebJS, { Client, LocalAuth } from "whatsapp-web.js";
import {
	encodeParsedMessage,
	formatToOpusAudio,
	isMessageFromNow,
	logWithDate,
	mapToParsedMessage,
	parseMessage,
	validatePhoneStr,
} from "./utils";
import { DBAutomaticMessage, ParsedMessage, SendFileOptions } from "./types";
import loadMessages from "./functions/loadMessages";
import loadAvatars from "./functions/loadAvatars";
import { schedule } from "node-cron";
import runAutoMessage from "./build-automatic-messages";
import Log from "./log";
import whatsappClientPool from "./connection";

class WhatsappInstance {
	public readonly requestURL: string;
	public readonly client: Client;
	public readonly clientName: string;
	public readonly whatsappNumber;
	public readonly pool: Pool;
	public isAuthenticated: boolean = false;
	public isReady: boolean = false;
	public connectionParams: ConnectionOptions;
	public blockedNumbers: Array<string> = [];
	public autoMessageCounters: Map<
		number,
		Array<{ number: string; count: number }>
	> = new Map();
	public awaitingMessages: {
		numbers: Array<string>;
		messages: Array<WAWebJS.Message>;
	} = { numbers: [], messages: [] };
	private readonly autoMessages: Array<DBAutomaticMessage> = [];
	private contactQueues: Map<string, Array<() => Promise<void>>> = new Map();
	private contactProcessing: Map<string, boolean> = new Map();

	constructor(
		clientName: string,
		whatsappNumber: string,
		requestURL: string,
		connection: ConnectionOptions
	) {
		this.clientName = clientName;
		this.whatsappNumber = whatsappNumber;
		this.requestURL = requestURL;
		this.connectionParams = connection;

		this.client = new Client({
			authStrategy: new LocalAuth({
				clientId: `${clientName}_${whatsappNumber}`,
			}),
			puppeteer: {
				headless: true,
				executablePath: process.env.CHROME_BIN || undefined,
				browserWSEndpoint: process.env.CHROME_WS || undefined,
				args: [
					"--no-sandbox",
					"--disable-setuid-sandbox",
					"--disable-dev-shm-usage",
					"--disable-accelerated-2d-canvas",
					"--no-first-run",
					"--no-zygote",
					"--disable-gpu",
				],
			},
			webVersionCache: {
				type: "remote",
				remotePath:
					"https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2346.52.html",
			},
		});

		schedule("30 7 * * *", async () => {
			try {
				await this.loadAvatars();
				logWithDate(
					`[${this.clientName} - ${this.whatsappNumber}] Avatars loaded successfully.`
				);
			} catch (err: any) {
				logWithDate(
					`[${this.clientName} - ${this.whatsappNumber}] Avatars loading failure =>`,
					err
				);
			}
		});

		schedule("*/2 * * * *", () => this.syncMessagesWithServer());

		this.buildBlockedNumbers();
		this.buildAutomaticMessages();
		this.buildClient();
		this.initialize();

		this.pool = createPool(this.connectionParams);
	}

	private async processContactQueue(contactNumber: string, type: string) {
		if (this.contactProcessing.get(contactNumber)) return;

		this.contactProcessing.set(contactNumber, true);

		while (this.contactQueues.get(contactNumber)?.length) {
			const task = this.contactQueues.get(contactNumber)!.shift();
			if (task) {
				logWithDate(
					`[${this.clientName} - ${this.whatsappNumber}] Processing ${type} for ${contactNumber}...`
				);
				await task();
			}
		}

		this.contactProcessing.set(contactNumber, false);
	}

	private enqueueProcessing(
		task: () => Promise<void>,
		type: string,
		contactNumber: string
	) {
		if (!this.contactQueues.has(contactNumber)) {
			this.contactQueues.set(contactNumber, []);
			this.contactProcessing.set(contactNumber, false);
		}

		this.contactQueues.get(contactNumber)!.push(task);
		this.processContactQueue(contactNumber, type);
	}

	public enqueueMessageProcessing(
		task: () => Promise<void>,
		contactNumber: string
	) {
		this.enqueueProcessing(task, "message", contactNumber);
	}

	public enqueueStatusProcessing(
		task: () => Promise<void>,
		contactNumber: string
	) {
		this.enqueueProcessing(task, "status", contactNumber);
	}

	private buildClient() {
		this.client.on("disconnected", async (reason) => {
			logWithDate("Disconnected =>", reason);
			/* axios.post(`${this.requestURL}/notify`, { message: "disconnected", reason }); */
		});

		this.client.on("change_state", (state) => {
			logWithDate("Changed State =>", state);
			/* axios.post(`${this.requestURL}/notify`, { message: "changed state", state }); */
		});

		this.client.on("qr", async (qr) => {
			try {
				await axios.post(
					`${this.requestURL}/qr/${this.whatsappNumber}`,
					{ qr }
				);
				logWithDate(
					`[${this.clientName} - ${this.whatsappNumber
					}] QR success => ${qr.slice(0, 30)}...`
				);
			} catch (err: any) {
				logWithDate(
					`[${this.clientName} - ${this.whatsappNumber}] QR failure =>`,
					err?.response
						? err.response.status
						: err.request
							? err.request._currentUrl
							: err
				);
			}
		});

		this.client.on("loading_screen", (percent, message) => {
			logWithDate(
				`[${this.clientName} - ${this.whatsappNumber}] Loading => ${message} ${percent}%`
			);
		});

		this.client.on("change_state", (state) => {
			logWithDate(
				`[${this.clientName} - ${this.whatsappNumber}] Chage state => ${state}`
			);
		});

		this.client.on("authenticated", async () => {
			try {
				await axios.post(
					`${this.requestURL}/auth/${this.whatsappNumber}`,
					{}
				);
				this.isAuthenticated = true;
				logWithDate(
					`[${this.clientName} - ${this.whatsappNumber}] Auth success!`
				);
			} catch (err: any) {
				logWithDate(
					`[${this.clientName} - ${this.whatsappNumber}] Auth failure =>`,
					err.response
						? err.response.status
						: err.request
							? err.request._currentUrl
							: err
				);
			}
		});

		this.client.on("ready", async () => {
			try {
				await axios.put(
					`${this.requestURL}/ready/${this.whatsappNumber}`
				);
				this.isReady = true;
				logWithDate(
					`[${this.clientName} - ${this.whatsappNumber}] Ready success!`
				);
			} catch (err: any) {
				logWithDate(
					`[${this.clientName} - ${this.whatsappNumber}] Ready failure =>`,
					err.response
						? err.response.status
						: err.request
							? err.request._currentUrl
							: err
				);
			}
		});

		this.client.on("message", (message) => this.onReceiveMessage(message));
		this.client.on("message_edit", (message) =>
			this.onEditMessage(message)
		);
		this.client.on("message_ack", (status) =>
			this.onReceiveMessageStatus(status)
		);
	}

	private async buildBlockedNumbers() {
		const [rows]: [RowDataPacket[], FieldPacket[]] =
			await whatsappClientPool.query(
				`SELECT * FROM blocked_numbers WHERE instance_number = ?`,
				[this.whatsappNumber]
			);

		this.blockedNumbers = rows.map((r) => r.blocked_number);
	}

	private async buildAutomaticMessages() {
		const SELECT_BOTS_QUERY =
			"SELECT * FROM automatic_messages WHERE instance_number = ? AND is_active = 1";
		const [rows]: [RowDataPacket[], FieldPacket[]] =
			await whatsappClientPool.query(SELECT_BOTS_QUERY, [this.whatsappNumber]);
		const autoMessages = rows as DBAutomaticMessage[];

		this.autoMessages.push(...autoMessages);
	}

	public async initialize() {
		try {
			await axios.put(`${this.requestURL}/init/${this.whatsappNumber}`);
			logWithDate(
				`[${this.clientName} - ${this.whatsappNumber}] Init success!`
			);
		} catch (err: any) {
			logWithDate(
				`[${this.clientName} - ${this.whatsappNumber}] Init failure =>`,
				err.response
					? err.response.status
					: err.request
						? err.request._currentUrl
						: err
			);
		} finally {
			await this.client.initialize();
		}
	}

	public async onReceiveMessage(message: WAWebJS.Message) {
		if (message.from == "status@broadcast") {
			return
		}

		this.enqueueMessageProcessing(async () => {
			const log = new Log<any>(
				this.client,
				this.clientName,
				"receive-message",
				`${message.id._serialized}`,
				{ message }
			);
			try {
				const blockedTypes = [
					"e2e_notification",
					"notification_template",
					"call_log",
					"gp2",
				];
				const fromNow = isMessageFromNow(message);
				const chat = await message.getChat();
				const contact = await chat.getContact()

				if (!contact) {
					return
				}

				const contactNumber = contact.number;

				const isStatus = message.isStatus;
				const isBlackListedType = blockedTypes.includes(message.type);
				const isBlackListedContact =
					this.blockedNumbers.includes(contactNumber);
				const isBlackListed = isBlackListedType || isBlackListedContact;
				const isValidNumber = validatePhoneStr(contactNumber);

				if (!isValidNumber) {
					return
				}

				for (const autoMessage of this.autoMessages) {
					await runAutoMessage(
						this,
						autoMessage,
						message,
						contactNumber,

					);
				}

				if (
					!chat.isGroup &&
					fromNow &&
					!isBlackListed &&
					!isStatus
				) {
					const parsedMessage = await parseMessage(message);
					log.setData((data) => ({ ...data, parsedMessage }));

					if (!parsedMessage) {
						throw new Error("Parse message failure");
					}
					await this.saveMessage(parsedMessage, contactNumber);

					await axios
						.post(
							`${this.requestURL}/receive_message/${this.whatsappNumber}/${contactNumber}`,
							parsedMessage
						)
						.catch((err: any) => {
							console.log(
								err.response
									? {
										status: err.response.status,
										data: err.response.data,
									}
									: err.message
							);
						});

					const savedMessage = await this.pool
						.query("SELECT * FROM w_mensagens WHERE ID = ?", [
							parsedMessage!.ID,
						])
						.then(([rows]: any) => {
							return rows[0];
						});

					log.setData((data) => ({ ...data, savedMessage }));
					if (savedMessage) {
						this.updateMessage(parsedMessage.ID, {
							SYNC_MESSAGE: true,
							SYNC_STATUS: true,
						});
					}

					logWithDate(
						`[${this.clientName} - ${this.whatsappNumber}] Message success => ${message.id._serialized}`
					);
				}
			} catch (err: any) {
				log.setError(err);
				log.save();

				logWithDate(
					`[${this.clientName} - ${this.whatsappNumber}] Message failure =>`,
					err.response ? err.response.data : err
				);
			}
		}, message.id.remote);
	}

	public async onReceiveMessageStatus(message: WAWebJS.Message) {
		this.enqueueStatusProcessing(async () => {
			try {
				const status =
					["PENDING", "SENT", "RECEIVED", "READ", "PLAYED"][
					message.ack
					] || "ERROR";

				await axios
					.put(
						`${this.requestURL}/update_message/${message.id._serialized}`,
						{ status }
					)
					.catch(() => null);
				await this.updateMessage(message.id._serialized, {
					SYNC_STATUS: true,
				});
				logWithDate(
					`[${this.clientName} - ${this.whatsappNumber}] Status success => ${status} ${message.id._serialized}`
				);
			} catch (err: any) {
				logWithDate(
					`[${this.clientName} - ${this.whatsappNumber}] Status failure =>`,
					err.response
						? err.response.status
						: err.request
							? err.request._currentUrl
							: err
				);
				await this.updateMessage(message.id._serialized, {
					SYNC_STATUS: false,
				});
			}
		}, message.id._serialized);
	}

	public async onEditMessage(message: WAWebJS.Message) {
		try {
			const TIMESTAMP = Number(`${message.timestamp}000`);

			const changes = {
				MENSAGEM: message.body,
				DATA_HORA: new Date(TIMESTAMP),
				TIMESTAMP,
			};

			await axios.post(
				`${this.requestURL}/update_message/${message.id._serialized}`,
				changes
			);
			logWithDate(
				`[${this.clientName} - ${this.whatsappNumber}] Message edit success => ${message.id._serialized}`
			);
		} catch (err: any) {
			logWithDate(
				`[${this.clientName} - ${this.whatsappNumber}] Message edit failure => `,
				err
			);
		}
	}

	public async loadMessages() {
		try {
			return await loadMessages(this);
		} catch (err) {
			throw err;
		}
	}

	public async loadAvatars() {
		try {
			return await loadAvatars(this);
		} catch (err) {
			throw err;
		}
	}

	public async loadGroups() {
		try {
			const chats = await this.client.getChats();
			const groups = chats.filter((chat) => chat.isGroup);

			return groups;
		} catch (err) {
			throw err;
		}
	}

	public async sendText(
		contact: string,
		text: string,
		quotedMessageId?: string
	) {
		const log = new Log<any>(
			this.client,
			this.clientName,
			"send-text",
			`${Date.now()}`,
			{ contact, text, quotedMessageId }
		);
		try {
			log.event("started sendText function");

			const numberId = await this.client.getNumberId(contact);
			const chatId = numberId && numberId._serialized;
			log.event("fetched contact's whatsapp id");
			log.setData(data => ({ ...data, chatId }))


			if (chatId) {
				const sentMessage = await this.client.sendMessage(
					chatId,
					text,
					{ quotedMessageId }
				);
				log.event("sent whatsapp message");
				log.setData((data) => ({ ...data, sentMessage }));

				const parsedMessage = await parseMessage(sentMessage);
				log.event("parsed message");
				log.setData((data) => ({ ...data, parsedMessage }));

				if (parsedMessage) {
					logWithDate(
						`[${this.clientName} - ${this.whatsappNumber}] Send text success => ${parsedMessage.ID}`
					);
				}

				return parsedMessage;
			}
		} catch (err: any) {
			log.setError(err);
			log.save();
			logWithDate(
				`[${this.clientName} - ${this.whatsappNumber}] Send text failure =>`,
				err
			);
		}
	}

	public async sendFile(options: SendFileOptions) {
		const log = new Log<any>(
			this.client,
			this.clientName,
			"send-file",
			`${Date.now()}`,
			{ options }
		);
		try {
			const {
				contact,
				file,
				mimeType,
				fileName,
				caption,
				quotedMessageId,
				isAudio,
			} = options;
			let formatedFile: unknown & any = file.toString("base64");

			if (isAudio === "true") {
				formatedFile = (
					(await formatToOpusAudio(file)) as any
				).toString("base64");
			}

			const chatId = `${contact}@c.us`;
			const media = new WAWebJS.MessageMedia(
				mimeType,
				formatedFile,
				fileName
			);
			const sentMessage = await this.client.sendMessage(chatId, media, {
				caption,
				quotedMessageId,
				sendAudioAsVoice: !!isAudio,
			});
			log.setData((data) => ({ ...data, sentMessage }));
			const parsedMessage = await parseMessage(sentMessage);
			log.setData((data) => ({ ...data, parsedMessage }));

			if (parsedMessage) {
				logWithDate(
					`[${this.clientName} - ${this.whatsappNumber}] Send file success => ${parsedMessage.ID}`
				);
			}

			return parsedMessage;
		} catch (err: any) {
			log.setError(err);
			log.save();
			logWithDate(
				`[${this.clientName} - ${this.whatsappNumber}] Send file failure  =>`,
				err
			);
		}
	}

	public async getProfilePicture(number: string) {
		try {
			const pfpURL = await this.client.getProfilePicUrl(number + "@c.us");
			logWithDate("Get PFP URL Success!");

			return pfpURL || null;
		} catch (err) {
			logWithDate("Get PFP URL err =>", err);
			return null;
		}
	}

	public async getContactVars(number: string) {
		try {
			const currentSaudation = () => {
				const currentTime = new Date();
				const hour = currentTime.getHours();

				if (hour >= 5 && hour < 12) {
					return "Bom dia";
				} else if (hour >= 12 && hour < 18) {
					return "Boa tarde";
				} else {
					return "Boa noite";
				}
			};

			const vars = {
				saudação_tempo: currentSaudation(),
				cliente_razao: "",
				cliente_cnpj: "",
				contato_primeiro_nome: "",
				contato_nome_completo: "",
			};

			const SELECT_QUERY = `
            SELECT 
                cli.RAZAO,
                cli.CPF_CNPJ,
                ct.NOME
            FROM w_clientes_numeros ct
            LEFT JOIN clientes cli ON cli.CODIGO = ct.CODIGO_CLIENTE
            WHERE ct.NUMERO = ?
            `;

			const [rows] = await this.pool.query(SELECT_QUERY, [number]);
			const findContact = (
				rows as Array<{ RAZAO: string; CNPJ: string; NOME: string }>
			)[0];

			vars.cliente_razao = findContact.RAZAO;
			vars.cliente_cnpj = findContact.CNPJ;
			vars.contato_primeiro_nome = findContact.NOME.split(" ")[0];
			vars.contato_nome_completo = findContact.NOME;

			return vars;
		} catch (err) {
			logWithDate("Get Contact vars err =>", err);
			throw err;
		}
	}

	public async validateNumber(number: string) {
		const isValid = await this.client.getNumberId(number);

		return !!isValid && isValid.user;
	}

	private async saveMessage(message: ParsedMessage, from: string) {
		message = encodeParsedMessage(message);

		const log = new Log<any>(
			this.client,
			this.clientName,
			"save-local-message",
			message.ID,
			{ message }
		);
		try {
			const query = `
				INSERT INTO messages (
					ID,
					MENSAGEM,
					ID_REFERENCIA,
					TIPO,
					TIMESTAMP,
					FROM_ME,
					DATA_HORA,
					STATUS,
					ARQUIVO_TIPO,
					ARQUIVO_NOME_ORIGINAL,
					ARQUIVO_NOME,
					ARQUIVO_ARMAZENAMENTO,
					SYNC_MESSAGE,
					SYNC_STATUS,
					INSTANCE,
					\`FROM\`
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON DUPLICATE KEY UPDATE
					MENSAGEM = VALUES(MENSAGEM),
					TIPO = VALUES(TIPO),
					TIMESTAMP = VALUES(TIMESTAMP),
					FROM_ME = VALUES(FROM_ME),
					DATA_HORA = VALUES(DATA_HORA),
					STATUS = VALUES(STATUS),
					ARQUIVO_TIPO = VALUES(ARQUIVO_TIPO),
					ARQUIVO_NOME_ORIGINAL = VALUES(ARQUIVO_NOME_ORIGINAL),
					ARQUIVO_NOME = VALUES(ARQUIVO_NOME),
					ARQUIVO_ARMAZENAMENTO = VALUES(ARQUIVO_ARMAZENAMENTO),
					SYNC_MESSAGE = VALUES(SYNC_MESSAGE),
					SYNC_STATUS = VALUES(SYNC_STATUS);
			`;

			const params = [
				message.ID,
				message.MENSAGEM || "",
				message.ID_REFERENCIA || null,
				message.TIPO || null,
				message.TIMESTAMP || null,
				message.FROM_ME ? 1 : 0,
				message.DATA_HORA || new Date(message.TIMESTAMP),
				message.STATUS || null,
				message.ARQUIVO?.TIPO || null,
				message.ARQUIVO?.NOME_ORIGINAL || null,
				message.ARQUIVO?.NOME_ARQUIVO || null,
				message.ARQUIVO?.ARMAZENAMENTO || null,
				0, // SYNC_MESSAGE
				0, // SYNC_STATUS,
				`${this.clientName}_${this.whatsappNumber}`,
				from,
			];

			try {
				await whatsappClientPool.query(query, params);
			} catch (err) {
				logWithDate(`[${this.clientName} - ${this.whatsappNumber}] MySQL Pool Query error =>`, err);
				throw err;
			}

			logWithDate(
				`[${this.clientName} - ${this.whatsappNumber}] Message saved successfully => ${message.ID}`
			);
		} catch (err: any) {
			log.setError(err);
			log.save();
			logWithDate(
				`[${this.clientName} - ${this.whatsappNumber}] Save message failure =>`,
				err
			);
		}
	}

	private async syncMessagesWithServer() {
		try {
			const [rows]: [RowDataPacket[], FieldPacket[]] =
				await whatsappClientPool.query(
					`
				SELECT * FROM messages 
				WHERE (SYNC_MESSAGE = 0 OR SYNC_STATUS = 0) 
				AND INSTANCE = ?
			`,
					[`${this.clientName}_${this.whatsappNumber}`]
				);

			for (const message of rows) {
				const { ID, SYNC_MESSAGE, SYNC_STATUS, STATUS } = message;
				const log = new Log<any>(
					this.client,
					this.clientName,
					"sync-message",
					ID,
					{}
				);
				try {
					// Sincronizar mensagem com o servidor
					if (!SYNC_MESSAGE) {
						const parsedMessage = mapToParsedMessage(message);
						log.setData(() => ({ parsedMessage }));

						await axios
							.post(
								`${this.requestURL}/receive_message/${this.whatsappNumber}/${message.FROM}`,
								parsedMessage
							)
							.then(() =>
								this.updateMessage(ID, {
									SYNC_MESSAGE: true,
									SYNC_STATUS: true,
								})
							);
					}

					// Sincronizar status da mensagem com o servidor
					if (SYNC_MESSAGE && !SYNC_STATUS) {
						log.setData(() => ({ status: STATUS }));
						await axios
							.put(
								`${this.requestURL}/update_message/${message.FROM}`,
								{ status: STATUS }
							)
							.then(() =>
								this.updateMessage(ID, { SYNC_STATUS: true })
							);
					}

					logWithDate(
						`[${this.clientName} - ${this.whatsappNumber}] Sync message success: ${ID}`
					);
				} catch (err: any) {
					log.setError(err);
					log.save();
					logWithDate(
						`[${this.clientName} - ${this.whatsappNumber}] Sync message failure =>`,
						err?.message
					);
				}
			}
		} catch (err: any) {
			logWithDate(
				`[${this.clientName} - ${this.whatsappNumber}] Sync messages failure =>`,
				err?.message
			);
		}
	}

	private async updateMessage(
		id: string,
		{
			SYNC_STATUS,
			SYNC_MESSAGE,
			STATUS,
		}: { SYNC_STATUS?: boolean; SYNC_MESSAGE?: boolean; STATUS?: string }
	) {
		try {
			const query = `UPDATE messages SET STATUS = COALESCE(?, STATUS), SYNC_STATUS = COALESCE(?, SYNC_STATUS), SYNC_MESSAGE = COALESCE(?, SYNC_MESSAGE) WHERE ID = ?;`;

			const params = [
				STATUS || null,
				SYNC_STATUS !== undefined ? SYNC_STATUS : null,
				SYNC_MESSAGE !== undefined ? SYNC_MESSAGE : null,
				id,
			];

			await whatsappClientPool.query(query, params);

			logWithDate(
				`[${this.clientName} - ${this.whatsappNumber}] Message updated successfully => ${id}`
			);
		} catch (err) {
			logWithDate(
				`[${this.clientName} - ${this.whatsappNumber}] Update message failure =>`,
				err
			);
		}
	}
}

export default WhatsappInstance;
