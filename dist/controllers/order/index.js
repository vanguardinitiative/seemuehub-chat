"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.orderController = void 0;
const config_1 = require("../../config");
const redis_1 = require("../../config/redis");
const conversation_1 = require("../../models/conversation");
const message_1 = require("../../models/message");
const handleOrderStatusUpdate = async (orderData) => {
    try {
        const { orderId, orderStatus, orderSender, _id } = orderData;
        console.log("_id===>", _id);
        if (!orderId || !orderStatus) {
            console.log("⚠️ OrderId or status missing");
            return null;
        }
        let messageContent = `Order status updated to ${orderStatus}`;
        switch (orderStatus) {
            case "SUBMITTED_PROPOSAL":
                messageContent = "ສ້າງໃບສະເໜີລາຄາສຳເລັດເເລ້ວ ສາມາດກວດສອບໄດ້ເລີຍ";
                break;
            case "ACCEPTED_PROPOSAL":
                messageContent = "ອະນຸມັດໃບສະເໜີລາຄາສຳເລັດເເລ້ວ";
                break;
            case "REJECTED_PROPOSAL":
                messageContent = "ປະຕິເສດໃບສະເໜີລາຄາ";
                break;
            case "PAYMENT_SUCCESS":
                messageContent = "ຊຳລະເງິນສຳເລັດເເລ້ວ ເລີ່ມວຽກໄດ້ເລີຍ";
                break;
            case "SUBMITTED_DELIVERABLE":
                messageContent = "ສົ່ງມອບວຽກເເລ້ວ ສາມາດກວດສອບໄດ້ເລີຍ";
                break;
            case "REJECTED_DELIVERABLE":
                messageContent = "ຕ້ອງການເເກ້ໄຂການສົ່ງມອບວຽກ";
                break;
            case "COMPLETED":
                messageContent = "Order ສຳເລັດເເລ້ວ";
                break;
        }
        const orderMessage = await message_1.messageModel.create({
            sender: orderSender,
            conversation: _id,
            fileUploaded: true,
            messageType: message_1.MessageType.TEXT,
            content: messageContent,
            isOrderMessage: true,
            createdAt: new Date(),
            sendAt: new Date(),
        });
        console.log("🔔 orderMessage===>", orderMessage);
        const updatedConversation = await conversation_1.conversationModel.findByIdAndUpdate(_id, {
            latestMessageData: {
                senderId: orderSender,
                messageId: orderMessage._id.toString(),
                content: messageContent,
                readAllAt: null,
                sendAt: new Date(),
                deliveredAllAt: new Date(),
                orderStep: orderStatus,
            },
        }, { new: true });
        console.log("🔔 updatedConversation===>", updatedConversation);
        await redis_1.pub.publish("SEND_MESSAGE", JSON.stringify({
            conversation: updatedConversation,
            messageData: orderMessage,
        }));
        console.log(`✅ Order status message created for order ${orderId}: ${orderStatus}`);
        return {
            message: orderMessage,
            conversation: updatedConversation,
        };
    }
    catch (error) {
        console.error("Error handling order status update:", error instanceof Error ? error.message : "Unknown error");
        throw error;
    }
};
const orderController = async (req, res) => {
    try {
        const orderData = req.body;
        console.log("orderData===>", orderData.latestMessageData.orderStep);
        if (orderData.orderId) {
            try {
                await handleOrderStatusUpdate({
                    orderId: orderData.orderId,
                    orderStatus: orderData.latestMessageData.orderStep,
                    orderSender: orderData.orderSender,
                    _id: orderData._id,
                });
            }
            catch (error) {
                console.error("Error in handleOrderStatusUpdate:", error);
            }
        }
        redis_1.pub.publish("ORDER", JSON.stringify(orderData));
        res.status(200).json(config_1.messages.SUCCESSFULLY);
        return;
    }
    catch (error) {
        console.log("Error in orderController:", error);
        res.status(500).json(config_1.messages.INTERNAL_SERVER_ERROR);
        return;
    }
};
exports.orderController = orderController;
//# sourceMappingURL=index.js.map