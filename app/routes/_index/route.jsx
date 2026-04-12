import { redirect } from "@remix-run/node";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const searchParams = url.searchParams.toString();
  throw redirect(searchParams ? `/app?${searchParams}` : "/app");
};
