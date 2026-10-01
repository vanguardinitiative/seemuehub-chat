import { messages } from "@/config";
import { pub } from "@/config/redis";
import { Request, Response } from "express";
import mongoose from "mongoose";
import { conversationModel } from "@/models/conversation";
import { messageModel, MessageType } from "@/models/message";
import { orderStepMessage } from "./step-message";

// Handle order status update - creates automatic message and updates conversation
const handleOrderStatusUpdate = async (orderData: {
  orderId: string | mongoose.Types.ObjectId;
  orderStatus: string;
  orderSender: string;
  _id: mongoose.Types.ObjectId;
}): Promise<{ message: any; conversation: any } | null> => {
  try {
    const { orderId, orderStatus, orderSender, _id } = orderData;
    console.log("_id===>", _id);

    if (!orderId || !orderStatus) {
      console.log("⚠️ OrderId or status missing");
      return null;
    }

    const messageContent = orderStepMessage(orderStatus);

    // Create automatic message
    const orderMessage = await messageModel.create({
      sender: orderSender,
      conversation: _id,
      fileUploaded: true,
      messageType: MessageType.TEXT,
      content: messageContent,
      isOrderMessage: true,
      createdAt: new Date(),
      sendAt: new Date(),
    });
    console.log("🔔 orderMessage===>", orderMessage);

    // Update conversation with latest message and order status
    const updatedConversation = await conversationModel.findByIdAndUpdate(
      _id,
      {
        latestMessageData: {
          senderId: orderSender,
          messageId: orderMessage._id.toString(),
          messageType: orderMessage.messageType,
          content: messageContent,
          readAllAt: null,
          sendAt: new Date(),
          deliveredAllAt: new Date(),
          orderStep: orderStatus,
        },
      },
      { new: true }
    );
    console.log("🔔 updatedConversation===>", updatedConversation);

    // Publish message to trigger notifications
    await pub.publish(
      "SEND_MESSAGE",
      JSON.stringify({
        conversation: updatedConversation,
        messageData: orderMessage,
      })
    );

    console.log(`✅ Order status message created for order ${orderId}: ${orderStatus}`);

    return {
      message: orderMessage,
      conversation: updatedConversation,
    };
  } catch (error) {
    console.error("Error handling order status update:", error instanceof Error ? error.message : "Unknown error");
    throw error;
  }
};

export const orderController = async (req: Request, res: Response): Promise<void> => {
  try {
    const orderData = req.body;
    console.log("orderData===>", orderData.latestMessageData.orderStep);
    // Create automatic message if orderId and status are provided
    if (orderData.orderId) {
      try {
        await handleOrderStatusUpdate({
          orderId: orderData.orderId,
          orderStatus: orderData.latestMessageData.orderStep,
          orderSender: orderData.orderSender,
          _id: orderData._id,
        });
      } catch (error) {
        console.error("Error in handleOrderStatusUpdate:", error);
        // Continue to publish ORDER notification even if message creation fails
      }
    }

    // Publish ORDER notification to Redis for socket.io notifications
    pub.publish("ORDER", JSON.stringify(orderData));
    res.status(200).json(messages.SUCCESSFULLY);
    return;
  } catch (error) {
    console.log("Error in orderController:", error);
    res.status(500).json(messages.INTERNAL_SERVER_ERROR);
    return;
  }
};
