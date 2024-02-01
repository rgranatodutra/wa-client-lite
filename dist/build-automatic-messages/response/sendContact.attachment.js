"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
function sendContact(instance, message, number) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const numberId = yield instance.client.getNumberId(number);
            console.log(numberId);
            if (numberId) {
                const contact = yield instance.client.getContactById(numberId === null || numberId === void 0 ? void 0 : numberId._serialized);
                contact && (yield message.reply(contact));
            }
        }
        catch (err) {
            console.error(err);
        }
    });
}
exports.default = sendContact;
//# sourceMappingURL=sendContact.attachment.js.map