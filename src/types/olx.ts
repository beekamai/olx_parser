export interface OlxAdData {
  id: string;
  title: string;
  description: string;
  price: string | null;
  location: {
    city: string | null;
    district: string | null;
    region: string | null;
  };
  phones: string[];
  contact: {
    name: string | null;
    negotiation: boolean;
  };
  url: string;
  photos: string[];
}
