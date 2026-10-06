import { messages } from "@/config";
import { pub } from "@/config/redis";
import { Request, Response } from "express";
import mongoose from "mongoose";
import { conversationModel } from "@/models/conversation";
import { messageModel, MessageType } from "@/models/message";
import { orderStepMessage } from "./step-message";
import { idString, isObjectIdString } from "@/utils/ids";

/** A mongoose document as res.json / JSON.stringify would see it; anything else as is. */
const plain = (value: any) => (value && typeof value.toJSON === "function" ? value.toJSON() : value);

// Handle order status update - creates automatic message and updates conversation
const handleOrderStatusUpdate = async (orderData: {
  orderId: string | mongoose.Types.ObjectId;
  /** The step (latestMessageData.orderStep), not an order status. */
  orderStep: string;
  orderSender: string;
  _id: mongoose.Types.ObjectId;
}): Promise<{ message: any; conversation: any } | null> => {
  try {
    const { orderId, orderStep, orderSender, _id } = orderData;

    if (!orderId || !orderStep) {
      console.warn("Order step not stored: orderId or orderStep missing", { orderId, conversationId: _id });
      return null;
    }

    const messageContent = orderStepMessage(orderStep);
    // Only a well-formed id: one that does not cast would fail the whole
    // message, and the step's message matters more than the link.
    const storedOrderId = idString(orderId);

    // Create automatic message. Still a TEXT with the step's line as its
    // content, which is all older clients read; newer ones draw the step's
    // card from orderStep and orderId.
    const orderMessage = await messageModel.create({
      sender: orderSender,
      conversation: _id,
      fileUploaded: true,
      messageType: MessageType.TEXT,
      content: messageContent,
      isOrderMessage: true,
      orderStep,
      ...(isObjectIdString(storedOrderId) ? { orderId: storedOrderId } : {}),
      createdAt: new Date(),
      sendAt: new Date(),
    });

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
          orderStep,
        },
      },
      { new: true }
    );

    // Publish message to trigger notifications
    await pub.publish(
      "SEND_MESSAGE",
      JSON.stringify({
        conversation: updatedConversation,
        messageData: orderMessage,
      })
    );

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
    // The order's conversation as seemuehub-backend saw it, before this step.
    const orderData = req.body;
    let notice = orderData;
    // Create automatic message if orderId and status are provided
    if (orderData.orderId) {
      try {
        const stored = await handleOrderStatusUpdate({
          orderId: orderData.orderId,
          orderStep: orderData.latestMessageData?.orderStep,
          orderSender: orderData.orderSender,
          _id: orderData._id,
        });
        // ORDER carries the conversation's latest message as it is now, with
        // the step's message in it, instead of the backend's copy from before
        // the step (CHAT-CONTRACT.md §1.5). Clients still refetch on ORDER.
        const fresh = plain(stored?.conversation);
        if (fresh?.latestMessageData) {
          notice = { ...orderData, latestMessageData: fresh.latestMessageData, updatedAt: fresh.updatedAt ?? orderData.updatedAt };
        }
      } catch (error) {
        console.error("Error in handleOrderStatusUpdate:", error);
        // Continue to publish ORDER notification even if message creation fails
      }
    }

    // Publish ORDER notification to Redis for socket.io notifications
    pub.publish("ORDER", JSON.stringify(notice));
    res.status(200).json(messages.SUCCESSFULLY);
    return;
  } catch (error) {
    console.error("Error in orderController:", error);
    res.status(500).json(messages.INTERNAL_SERVER_ERROR);
    return;
  }
};
