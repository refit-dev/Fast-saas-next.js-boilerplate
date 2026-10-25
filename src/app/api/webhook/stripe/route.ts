import { ReciptEmail } from "@/components/Emails/ReciptEmail";
import { stripe } from "@/lib/Stripe";
import prisma from "@/lib/utils";
import { render } from "@react-email/components";
import { headers } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { buffer } from "node:stream/consumers";
import nodemailer from "nodemailer";
import type Stripe from "stripe";

type PeriodItem = { price?: { id?: string } | null };
type PeriodField = 'current_period_start' | 'current_period_end';
type PlanItem = (items: PeriodItem[]) => PeriodItem | undefined;

// Typed like the removed field, which was also absent at runtime when Stripe omitted it.
function subscriptionPeriod(subscription: object, field: PeriodField, planItem?: PlanItem): number {
  const legacy: unknown = Reflect.get(subscription, field);
  if (typeof legacy === 'number') return legacy;
  const list: unknown = Reflect.get(subscription, 'items');
  const data: unknown = list && typeof list === 'object' ? Reflect.get(list, 'data') : undefined;
  const items = (Array.isArray(data) ? data : []).filter(
    (item): item is PeriodItem => typeof item === 'object' && item !== null,
  );
  const periods = new Set(items.map((item) => Reflect.get(item, field)));
  const chosen = periods.size === 1 ? items[0] : planItem?.(items);
  const value: unknown = chosen ? Reflect.get(chosen, field) : undefined;
  return (typeof value === 'number' ? value : undefined) as number;
}

function getSubscriptionPeriodEnd(subscription: object, planItem?: PlanItem): number {
  return subscriptionPeriod(subscription, 'current_period_end', planItem);
}
export async function POST(req: NextRequest, res: NextResponse) {
  //@ts-expect-error Argument of type 'ReadableStream<any>' is not assignable to parameter of type 'ReadableStream | Readable | AsyncIterable<any>'
  const body = await buffer(req.body);
  const signature = headers().get("Stripe-Signature") as string;

  let event: Stripe.Event | undefined = undefined;
  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET || ""
    );
  } catch (err: any) {
    return new NextResponse(
      JSON.stringify({ error: "Webhook error" + err.message }),
      {
        status: 400,
      }
    );
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const transporter = nodemailer.createTransport({
    host: "smtp.google.com",
    secure: true,
    service: "Gmail",
    port: 25,
    auth: {
      user: process.env.GOOGLE_ID!,
      pass: process.env.GOOGLE_PASS!,
    },
    tls: {
      rejectUnauthorized: false,
    },
  });
  if (!session?.metadata?.userId) {
    return new NextResponse(
      JSON.stringify({ error: "Webhook Error: No user present in metadata" }),
      {
        status: 400,
      }
    );
  }

  switch (event.type) {
    case "checkout.session.completed":
      // Then define and call a function to handle the event checkout.session.completed
      const users = await prisma?.user.findFirst({
        where: { id: session.metadata.userId },
      });

      if (!users)
        return new NextResponse(JSON.stringify({ error: "No user Found" }), {
          status: 400,
        });

      const subscription = await stripe.subscriptions.retrieve(
        session.subscription as string
      );

      await prisma.user.update({
        where: {
          id: session?.metadata?.userId,
        },
        data: {
          UserAccessLevel: "Pro",
          stripeSubscriptionId: subscription.id,
          stripe_customer_id: subscription.customer as string,
          stripePriceId: subscription.items.data[0].price.id,
          stripeCurrentPeriodEnd: new Date(
            (getSubscriptionPeriodEnd(subscription, (items) => items[0])) * 1000
          ),
        },
      });

      // send receipt
      const emailHtml = render(
        ReciptEmail({ userFirstname: users.name as string })
      );
      await transporter.sendMail({
        from: '"FastSaas" <noreply@yourcompany.com>',
        to: users.email as string,
        subject: "Thank You for Joining Our Family!",
        html: emailHtml,
      });
      break;

    case "customer.subscription.deleted":
      const deleteSubscription = await stripe.subscriptions.retrieve(
        session.subscription as string
      );

      await prisma.user.update({
        where: {
          stripe_customer_id: deleteSubscription.customer as string,
        },
        data: {
          UserAccessLevel: null,
          stripePriceId: null,
          stripeCurrentPeriodEnd: null,
        },
      });

      break;
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  return new Response(null, { status: 200 });
}
