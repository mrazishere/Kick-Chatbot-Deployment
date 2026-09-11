import { getSession } from "@/lib/session";
import { channelsManagedBy, getChannel } from "@/lib/bot-api";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * The dashboard root is "your own bot" — for the admin too. A moderator who has
 * been made a manager but runs no bot of their own would otherwise land on an
 * empty "add the bot" page, so they get sent to the channel they manage instead.
 */
export default async function Home() {
  const session = await getSession();
  if (!session.userId || !session.username) redirect("/login");

  const me = session.username;

  let ownEnrolled = false;
  try {
    await getChannel(me);
    ownEnrolled = true;
  } catch {
    ownEnrolled = false;
  }

  // redirect() signals by throwing, so the target is resolved inside the try and
  // the redirect itself happens outside it — otherwise the catch swallows it.
  let target = `/${me}/bot`;
  if (!ownEnrolled) {
    try {
      const { channels } = await channelsManagedBy(me);
      if (channels.length > 0 && channels[0]) target = `/${channels[0]}/bot`;
    } catch {
      // fall through to your own page
    }
  }

  redirect(target);
}
