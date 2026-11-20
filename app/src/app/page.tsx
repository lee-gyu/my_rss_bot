import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function Home() {
  return (
    <main className="grid min-h-dvh place-items-center bg-muted/40 px-6 py-10">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl font-semibold">RSS 리더</h1>
          </CardTitle>
          <CardDescription>수집한 RSS 글 목록을 준비 중입니다.</CardDescription>
        </CardHeader>
      </Card>
    </main>
  );
}
